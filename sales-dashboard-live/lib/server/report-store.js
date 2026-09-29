// Shared report snapshot layer.
//
// Every report built on this helper obeys one contract:
//
//   GET  ?action=<report>&ids=<one account>&...            -> read the SHARED
//        saved snapshot from Supabase. This NEVER calls DataDoe, so opening a
//        report, changing brand, filtering, sorting or paging costs nothing and
//        shows exactly what the last refresher fetched.
//   GET  ?action=<report>&ids=...&refresh=1                -> for a MANUAL-PAID
//        insight report (NOT route-owned) the one explicit operation allowed to
//        call DataDoe. It claims a database lock first, so two people clicking
//        Refresh cannot spend DataDoe tokens twice, then saves the validated
//        result for every permitted user and publishes a compact Realtime event.
//
// PUBLICATION RECOVERY WP10b -- ROUTE-OWNED LIVE REPORTS ARE READ-ONLY HERE (by default code, no flag). The ten
// route-owned live keys (ROUTE_OWNED_LIVE_REPORT_KEYS == the DB writer-fence seed, report-writer-fence.js) are published
// ONLY through the fenced four-gate publisher (scheduler / zero-export routes / reconcilers / the admin Data Sync Center
// paid sync). For them a refresh=1 is a READ (serveSharedReport coerces refresh -> false; beginSharedRefresh refuses
// typed BEFORE any lock/build; the durable self-heal is forced read-only; persistDerivedSnapshot refuses typed) -- so
// this module can never write a route-owned key, never claim its refresh lock and never run its (possibly paid) build.
// The explicit, owner-approved PAID sync stays available ONLY through the admin Data Sync Center (api/admin/sources.js
// POST: preview -> token estimate -> explicit confirmation token -> fenced publish); routeOwnedPaidSync() describes it.
//
// The account is always authorised by api/datadoe.js before this runs.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
// The ONE route-owned live key contract: the DB writer-fence seed (pure, dependency-free module).
import { FENCED_WRITER_REPORT_KEYS } from "./sync/report-writer-fence.js";

import {
  claimRefreshLock,
  getLatestReportSnapshot,
  getLatestReportSnapshotForScope,
  getReportSnapshot,
  isSupabaseConfigured,
  publishSnapshotUpdate,
  releaseRefreshLock,
  saveReportSnapshot,
} from "./supabase.js";

// A refresh that produces more than this is a design problem, not something to
// silently truncate or silently keep out of the shared store. Every new report
// aggregates server-side specifically to stay far below it.
// Canonical shared-snapshot payload ceiling now lives in the dependency-free limits leaf so
// every write path enforces ONE value. Imported locally (used below) and re-exported.
import { MAX_SNAPSHOT_BYTES } from "./report-limits.js";
export { MAX_SNAPSHOT_BYTES };

const DEFAULT_LOCK_SECONDS = 240;

// The snapshot identity hash lives in the PURE leaf report-params-hash.js (moved verbatim) so a read-only consumer can
// compute it without importing this module's supabase.js writers. Imported locally (used below) and re-exported, so
// every existing `import { paramsHashFor } from "./report-store.js"` is byte-identical.
import { paramsHashFor } from "./report-params-hash.js";
export { paramsHashFor };

export function wantsRefresh(req) {
  const value = String(req.query?.refresh ?? "").toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

// =====================================================================================================================
// PUBLICATION RECOVERY WP10b -- the refresh=1 READ-ONLY contract for ROUTE-OWNED live reports + the PAID-SYNC contract.
// =====================================================================================================================
// The route-owned live keys: EXACTLY the DB writer-fence seed (brand-sales, daily-reporting, brand-inventory,
// listing-health-v3, fba-plan, sku-movement, returns-leakage, brand-view, brand-view-portfolio, brand-view-brands).
export const ROUTE_OWNED_LIVE_REPORT_KEYS = FENCED_WRITER_REPORT_KEYS;
const ROUTE_OWNED_KEY_SET = new Set(ROUTE_OWNED_LIVE_REPORT_KEYS);
export function isRouteOwnedLiveReportKey(reportKey) {
  return typeof reportKey === "string" && ROUTE_OWNED_KEY_SET.has(reportKey);
}

// The typed refusal every write path of this module raises for a route-owned key (never a generic 500 text): a
// route-owned live row is written only by the fenced publisher, never by a dashboard refresh / self-heal persist.
export const ROUTE_OWNED_REPORT_READ_ONLY = "ROUTE_OWNED_REPORT_READ_ONLY";
export class RouteOwnedReportReadOnlyError extends Error {
  constructor(reportKey, where) {
    super(`${ROUTE_OWNED_REPORT_READ_ONLY}: "${reportKey}" is a route-owned live report; ${where} is read-only for it (it is published only through the fenced publisher; the paid sync is the admin Data Sync Center action).`);
    this.name = "RouteOwnedReportReadOnlyError";
    this.code = ROUTE_OWNED_REPORT_READ_ONLY;
    this.status = 409;
    this.reportKey = reportKey;
  }
}
export function assertNotRouteOwnedWrite(reportKey, where) {
  if (isRouteOwnedLiveReportKey(reportKey)) throw new RouteOwnedReportReadOnlyError(reportKey, where);
}

// Which Data Sync Center source cards (api/admin/sources.js POST sync, admin-only, preview -> confirm) refresh each
// route-owned report's SOURCE EVIDENCE. The cards acquire + persist DURABLE evidence under the existing token ceilings;
// the report itself is then (re)published only through the fenced publisher -- DIRECTLY in the same card operation
// (orchestrated OLI / Catalog / Campaign-Ads cards: the priority release publishes daily-reporting + brand-sales +
// brand-inventory; the FBA Inventory Health / Listings cards: the fba-plan operation publishes fba-plan) or on the next
// pass of its zero-export fenced route / reconciler (every other dependent). Hand-reviewed; pinned by
// scripts/refresh-readonly.test.js against the source registry + the card operations.
export const PAID_SYNC_SURFACE = Object.freeze({
  surface: "data-sync-center",
  endpoint: "POST /api/admin/sources",
  confirmation: "preview (token estimate) -> explicit confirmationToken -> execute",
});
const PAID_SYNC_BY_REPORT = Object.freeze({
  "brand-sales": Object.freeze({
    cards: Object.freeze(["order-line-items", "product-catalog"]),
    how: "Data Sync Center > Order Line Items (or Product Catalog) > Sync source: an admin-confirmed paid sync persists durable OLI/Catalog evidence and the SAME operation republishes Brand Sales (with Daily Reporting + Brand View inventory) through the fenced publisher, with exact live read-back.",
  }),
  "daily-reporting": Object.freeze({
    cards: Object.freeze(["order-line-items", "product-catalog", "ads-campaign-date"]),
    how: "Data Sync Center > Order Line Items, Product Catalog or Campaign Ads > Sync source: an admin-confirmed paid sync persists durable evidence and the SAME operation republishes Daily Reporting (with Brand Sales + Brand View inventory) through the fenced publisher, with exact live read-back.",
  }),
  "brand-inventory": Object.freeze({
    cards: Object.freeze(["fba-inventory-health", "order-line-items", "product-catalog"]),
    how: "Data Sync Center > FBA Inventory Health > Sync source persists the durable D-1 FBA snapshot (fba-plan operation, fenced) and the zero-export FBA reconciler republishes Brand View inventory through the fenced publisher; an Order Line Items / Product Catalog sync republishes it directly in its priority release.",
  }),
  "fba-plan": Object.freeze({
    cards: Object.freeze(["fba-inventory-health", "listings", "order-line-items", "product-catalog"]),
    how: "Data Sync Center > FBA Inventory Health (or Listings / AWD) > Sync source runs the fba-plan operation: a batched FBA/AWD fetch under the bucket token ceiling, then FBA Shipment Plan is published through the fenced publisher with exact live read-back. Order Line Items / Product Catalog syncs refresh its durable velocity + brand inputs; the zero-export fba-plan route republishes from durable evidence afterwards.",
  }),
  "listing-health-v3": Object.freeze({
    cards: Object.freeze(["order-line-items", "product-catalog", "fba-inventory-health"]),
    how: "Its paid Listings + Listings Raw acquisition is the scheduled scheduler-v2 listing-health-v3 job (ONE canonical shared Listings export per <=5-seller batch). The Data Sync Center cards listed refresh its durable OLI / Catalog / FBA inputs; the zero-export Listing Health v3 reconciler then republishes it through the fenced publisher.",
  }),
  "sku-movement": Object.freeze({
    cards: Object.freeze(["order-line-items", "product-catalog"]),
    how: "Data Sync Center > Order Line Items / Product Catalog > Sync source persists durable evidence; SKU Movement re-derives read-only from it on the next load (zero export) and its zero-export route republishes it through the fenced publisher.",
  }),
  "returns-leakage": Object.freeze({
    cards: Object.freeze(["order-line-items", "product-catalog"]),
    how: "Returns + Settlements history is acquired by the dedicated Returns workflow; the Data Sync Center Order Line Items / Product Catalog cards refresh its reused inputs, and its zero-export returns route republishes it from durable evidence through the fenced publisher.",
  }),
  "brand-view": Object.freeze({
    cards: Object.freeze(["order-line-items", "product-catalog", "ads-campaign-date", "fba-inventory-health"]),
    how: "Brand View is built only from saved evidence: a Data Sync Center paid sync of these sources republishes Brand Sales / Brand View inventory (fenced), then the zero-export Brand View route republishes this brand's view through the fenced publisher.",
  }),
  "brand-view-portfolio": Object.freeze({
    cards: Object.freeze(["order-line-items", "product-catalog", "ads-campaign-date", "fba-inventory-health"]),
    how: "The cross-account Brand View is built only from saved evidence: a Data Sync Center paid sync of these sources republishes Brand Sales / Brand View inventory (fenced), then the zero-export Brand View portfolio route republishes it through the fenced publisher.",
  }),
  "brand-view-brands": Object.freeze({
    cards: Object.freeze(["order-line-items", "product-catalog", "fba-inventory-health"]),
    how: "The account brand list is built only from saved Brand Sales / FBA Plan evidence: a Data Sync Center paid sync of these sources republishes that evidence (fenced), then the zero-export brand-list route republishes it through the fenced publisher.",
  }),
});

/**
 * The paid-sync descriptor a read-only refresh=1 of a route-owned report returns: { available (the caller is an
 * admin -- the Data Sync Center is admin-only), surface, endpoint, confirmation, cards, how }. null for any key that is
 * not route-owned (a manual-paid insight report keeps its own paid refresh).
 */
export function routeOwnedPaidSync(reportKey, { isAdmin = false } = {}) {
  if (!isRouteOwnedLiveReportKey(reportKey)) return null;
  const entry = PAID_SYNC_BY_REPORT[reportKey];
  return {
    available: isAdmin === true,
    ...PAID_SYNC_SURFACE,
    cards: [...entry.cards],
    how: entry.how,
  };
}

// The route-owned reports whose source evidence ONE Data Sync Center card refreshes (the inverse of the map above).
export function routeOwnedReportsForPaidSyncCard(sourceKey) {
  const k = String(sourceKey || "");
  return Object.keys(PAID_SYNC_BY_REPORT).filter((rk) => PAID_SYNC_BY_REPORT[rk].cards.includes(k)).sort();
}

// ---- SCHEDULER-V1 REFUSAL (WP10b). Scheduler v1 (run-sync.js -> report-adapter.js: adapter save + syncManaged prune +
// 30-day retention DELETE) is an UNFENCED writer. Every v1 entry point (api/admin/sync.js POST manual run, api/sync.js
// POST, api/cron/sync.js) dispatches ONLY non-route-owned keys; a route-owned key is refused with this typed 409 BEFORE
// any audit/lock/DataDoe work, so no v1 run can spend tokens and then fail at the DB writer fence. Non-route-owned
// controlled keys (manual-paid insight reports) keep their behaviour (classified 'manual-paid / not-applicable').
export const ROUTE_OWNED_REPORT_V1_REFUSED = "ROUTE_OWNED_REPORT_V1_REFUSED";
export function splitSchedulerV1ReportKeys(reportKeys) {
  const keys = [...new Set((reportKeys || []).map((k) => String(k)))];
  return { allowed: keys.filter((k) => !isRouteOwnedLiveReportKey(k)), refused: keys.filter((k) => isRouteOwnedLiveReportKey(k)) };
}
export function schedulerV1RouteOwnedRefusal(refusedReportKeys, { isAdmin = false } = {}) {
  const refused = [...new Set((refusedReportKeys || []).map(String))].filter(isRouteOwnedLiveReportKey).sort();
  return {
    error: ROUTE_OWNED_REPORT_V1_REFUSED,
    code: ROUTE_OWNED_REPORT_V1_REFUSED,
    refusedReportKeys: refused,
    message: "Scheduler v1 can no longer run " + refused.join(", ") + ": route-owned live reports are published only through the fenced publisher. Use the Data Sync Center source cards (admin paid sync with a token estimate + explicit confirmation) instead.",
    paidSync: Object.fromEntries(refused.map((k) => [k, routeOwnedPaidSync(k, { isAdmin })])),
  };
}

// ---- The explicit PAID-SYNC CONFIRMATION token (PROJECT_GUIDANCE section 2 + 4: expected spend vs approved ceiling
// shown BEFORE any spend; user approval required). A stateless HMAC-SHA256 token the Data Sync Center preview issues
// together with its token estimate and the execute step verifies on EVERY slice/poll. It binds the admin user, bucket,
// source card, refresh mode and the APPROVED token ceiling, and expires. Key: PAID_SYNC_CONFIRM_SECRET when set, else
// derived (one-way sha256 with a domain label) from the server-only Supabase service credential -- never sent to the
// browser, never logged. No key -> no token can be issued or verified (fail closed).
//
// v2 (WP10b fix, P2) additionally binds ONE OPERATION: the server-resolved as-of (D-1 at issue: a UTC-midnight roll
// between preview and execute is a typed 409 + re-preview, never a silent new day's spend), the operation slot
// (cycle bucket + cycle date), the slot's head cycle the preview observed ("" = none yet) with its PERSISTED spend at
// preview (the debit baseline), and the token kind: "start" (issued ONLY by an explicit preview) or "cont" (re-issued
// by an execute slice with the SAME nonce / approval / expiry, now recording the cycle the operation actually runs on,
// plus the Campaign-Ads phase spend that has no durable per-create ledger). A v1 token is refused (re-preview).
//
// v3 (WP10b re-verify P1 fix) additionally carries `aq`, the Campaign-Ads SLICE SEQUENCE, inside the HMAC-signed payload:
// a start token carries aq=0 and every continuation token issued after an Ads slice carries aq+1 (with the updated Ads
// spend `sp`). The Ads spend has no durable per-create ledger (the Ads phase opens no sync cycle), so the stateless token
// alone could be REPLAYED (the start token, or any older continuation, reset the Ads debit). The execute therefore claims
// a DURABLE SINGLE-USE RECEIPT for (nonce, aq) -- paidSyncAdsReceiptId below, an insert-if-absent into public.audit_log
// with that deterministic primary key (supabase.js claimPaidSyncReceipt) -- BEFORE any Ads create: each Ads-phase token
// is usable EXACTLY ONCE, so the signed spend chain is strictly linear and can never be rewound. A v1 or v2 token (minted
// before aq existed) is REFUSED with reason "version" (re-preview) -- never read as aq=0: every pre-change token of one
// confirmation (its start token AND each continuation, each carrying a different Ads spend) would then compete for the
// SAME sequence-0 receipt, and the winner could be the start token, whose sp=0 rewinds the Ads debit.
export const PAID_SYNC_CONFIRMATION_TTL_MS = 60 * 60 * 1000;
export function paidSyncConfirmationKey(env = process.env) {
  const secret = String((env && (env.PAID_SYNC_CONFIRM_SECRET || env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY)) || "").trim();
  return secret ? createHash("sha256").update("upriver/paid-sync-confirmation/v1\u0000" + secret).digest() : null;
}
const confirmationScope = ({ userId, bucket, sourceKey, refreshMode }) => ({
  u: String(userId == null ? "" : userId), b: String(bucket || ""), s: String(sourceKey || "*"), m: String(refreshMode || "normal"),
});
const PAID_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PAID_NONCE_RE = /^[A-Za-z0-9_-]{8,32}$/;
const nonNegInt = (v) => Number.isSafeInteger(v) && v >= 0;
/**
 * Issue a v3 confirmation. `asOf` (YYYY-MM-DD) and `operation` ({ key, cycleId ("" when the slot has no cycle yet),
 * baselineTokens, previewTerminal, adsSpentTokens, adsSliceSeq }) are REQUIRED; anything malformed -> null (fail closed,
 * no token). A continuation re-issue passes kind:"cont" + the verified claims' nonce / issuedAt / expiresAtMs so it can
 * never extend the approval's lifetime or change its ceiling. The Ads slice sequence (`aq`): a START token is always
 * aq=0 (an explicit non-zero value -> null); a CONTINUATION must pass it EXPLICITLY (a non-negative safe integer) -- there
 * is deliberately no default, so a caller that forgot to advance it can never silently re-mint an earlier sequence.
 */
export function issuePaidSyncConfirmation({ userId, bucket, sourceKey, refreshMode, approvedMaxTokens, asOf = null, operation = null, kind = "start", nonce = null, issuedAt = null, expiresAtMs = null, now = Date.now(), ttlMs = PAID_SYNC_CONFIRMATION_TTL_MS, key = paidSyncConfirmationKey() } = {}) {
  const approved = Number(approvedMaxTokens);
  if (!key || !Number.isSafeInteger(approved) || approved < 0) return null;
  if (!PAID_DATE_RE.test(String(asOf || "")) || !operation || typeof operation !== "object") return null;
  const o = String(operation.key || "").trim();
  const c = operation.cycleId == null ? "" : String(operation.cycleId);
  const sb = Number(operation.baselineTokens ?? 0);
  const sp = Number(operation.adsSpentTokens ?? 0);
  if (!o || !nonNegInt(sb) || !nonNegInt(sp) || (kind !== "start" && kind !== "cont")) return null;
  const aq = kind === "start" ? (operation.adsSliceSeq == null ? 0 : operation.adsSliceSeq) : operation.adsSliceSeq;
  if (!nonNegInt(aq) || (kind === "start" && aq !== 0)) return null;
  const e = expiresAtMs != null ? Number(expiresAtMs) : Number(now) + Number(ttlMs);
  const i = issuedAt != null ? Number(issuedAt) : Number(now);
  const n = nonce != null ? String(nonce) : randomBytes(9).toString("base64url");
  if (!Number.isFinite(e) || !Number.isFinite(i) || !PAID_NONCE_RE.test(n)) return null;
  const payload = {
    v: 3, ...confirmationScope({ userId, bucket, sourceKey, refreshMode }), t: approved, e, n, i, k: kind,
    a: String(asOf), o, c, sb, sp, aq, pt: operation.previewTerminal === true ? 1 : 0,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = createHmac("sha256", key).update(body).digest("base64url");
  return { token: body + "." + mac, expiresAt: new Date(payload.e).toISOString(), approvedMaxTokens: approved, kind };
}
export function verifyPaidSyncConfirmation(token, { userId, bucket, sourceKey, refreshMode, now = Date.now(), key = paidSyncConfirmationKey() } = {}) {
  if (!key) return { ok: false, reason: "unavailable" };
  if (typeof token !== "string" || token.trim() === "") return { ok: false, reason: "missing" };
  const parts = token.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || parts[0].length > 2048) return { ok: false, reason: "malformed" };
  const expected = createHmac("sha256", key).update(parts[0]).digest();
  let given;
  try { given = Buffer.from(parts[1], "base64url"); } catch { return { ok: false, reason: "malformed" }; }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad-signature" };
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); } catch { return { ok: false, reason: "malformed" }; }
  // v1 (pre-operation-binding) and v2 (pre-Ads-slice-sequence) tokens: re-preview. A v2 token is NEVER read as aq=0.
  if (payload && (payload.v === 1 || payload.v === 2)) return { ok: false, reason: "version" };
  if (!payload || payload.v !== 3 || !Number.isSafeInteger(payload.t) || payload.t < 0 || !Number.isFinite(payload.e) || !Number.isFinite(payload.i)
      || !PAID_DATE_RE.test(String(payload.a || "")) || typeof payload.o !== "string" || !payload.o || typeof payload.c !== "string"
      || !nonNegInt(payload.sb) || !nonNegInt(payload.sp) || (payload.k !== "start" && payload.k !== "cont")
      || typeof payload.n !== "string" || !PAID_NONCE_RE.test(payload.n)
      // the Ads slice sequence: a non-negative safe integer (missing / string / fractional / negative -> malformed); a
      // start token is always sequence 0.
      || !nonNegInt(payload.aq) || (payload.k === "start" && payload.aq !== 0)) return { ok: false, reason: "malformed" };
  if (Number(now) > payload.e) return { ok: false, reason: "expired" };
  const want = confirmationScope({ userId, bucket, sourceKey, refreshMode });
  if (payload.u !== want.u || payload.b !== want.b || payload.s !== want.s || payload.m !== want.m) return { ok: false, reason: "scope-mismatch" };
  return {
    ok: true, approvedMaxTokens: payload.t, expiresAt: new Date(payload.e).toISOString(), expiresAtMs: payload.e,
    nonce: payload.n, issuedAt: payload.i, kind: payload.k, asOf: payload.a, operationKey: payload.o, cycleId: payload.c,
    baselineTokens: payload.sb, adsSpentTokens: payload.sp, adsSliceSeq: payload.aq, previewTerminal: payload.pt === 1,
  };
}

/**
 * WP10b (re-verify P1) -- the DURABLE SINGLE-USE RECEIPT id for ONE Campaign-Ads paid-sync slice (pure, deterministic).
 * sha256("paid-sync-ads-receipt|v1|" + nonce + "|" + seq), its first 16 bytes shaped as an RFC 4122 UUID (version
 * nibble 5, variant bits 10) and printed as the canonical lowercase 8-4-4-4-12 string. `nonce` is the confirmation's own
 * nonce (random per explicit preview, bound inside the HMAC) and `seq` its Ads slice sequence (`aq`), so the id is the
 * SAME for every replay of one (confirmation, step) and different for every other one (collision-resistant: 122 hash
 * bits). The execute inserts it as public.audit_log's explicit primary key (supabase.js claimPaidSyncReceipt): the
 * first insert claims the step, every later one is a primary-key conflict -> the step is already used. Malformed input
 * THROWS (fail closed: no id -> no claim -> no Ads create).
 */
export function paidSyncAdsReceiptId({ nonce, seq } = {}) {
  if (typeof nonce !== "string" || !PAID_NONCE_RE.test(nonce)) throw new TypeError("PAID_SYNC_RECEIPT_ID_INPUT_INVALID: nonce must be a confirmation nonce");
  if (!nonNegInt(seq)) throw new TypeError("PAID_SYNC_RECEIPT_ID_INPUT_INVALID: seq must be a non-negative safe integer");
  const b = createHash("sha256").update("paid-sync-ads-receipt|v1|" + nonce + "|" + seq, "utf8").digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; // version 5 (name-based, SHA-derived)
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant (10xx)
  const h = b.toString("hex");
  return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20, 32);
}

const PAID_TERMINAL_CYCLE = new Set(["succeeded", "partial", "failed"]);
/**
 * WP10b (P2) ONE-OPERATION binding (pure). Given the verified claims and the operation slot's CURRENT head cycle (the
 * durable sync_cycles head for the claims' slot, or null), decide whether this confirmation may drive the execute:
 *   start token, no cycle at preview ("")  -> ok while the slot has no head (the first execute opens it) or a BASE head
 *                                             opened since (never a superseding attempt of someone else's cycle);
 *                                             a TERMINAL head means the approved operation already finished ->
 *                                             PAID_SYNC_OPERATION_FINISHED (a new confirmation is required);
 *   start token bound to cycle X            -> ok while X is the head and still open (or X was already terminal at
 *                                             preview: the admin approved finishing it -- the sync short-circuits);
 *                                             X finished since -> FINISHED; any other head -> CHANGED;
 *   cont token bound to X                   -> ok while X is the head (any status: release publish slices run on a
 *                                             finalized cycle) or the head is the priority release's legacy-recovery
 *                                             attempt superseding X (the SAME operation continuing); else CHANGED;
 *   cont token with no cycle yet (Ads phase) -> as the start token.
 * Returns { ok:true, cycleIds (the cycles whose PERSISTED spend is debited), boundCycleId } | { ok:false, code, message }.
 */
export function paidSyncOperationBinding({ claims, head } = {}) {
  const fail = (code, message) => ({ ok: false, code, message });
  const c = claims && typeof claims.cycleId === "string" ? claims.cycleId : "";
  const h = head && head.id != null && String(head.id) !== "" ? head : null;
  const hid = h ? String(h.id) : "";
  const terminal = h ? PAID_TERMINAL_CYCLE.has(String(h.status)) : false;
  const superseding = h ? String(h.supersedes_cycle_id ?? h.supersedesCycleId ?? "") : "";
  const legacyChildOfBound = !!(h && c && superseding === c && /^priority-legacy-recovery\//.test(String(h.operation_key ?? h.operationKey ?? "")));
  const changed = () => fail("PAID_SYNC_OPERATION_CHANGED", "The operation this confirmation approved is no longer the active one for this bucket and date (another run owns it now). Review the fresh estimate and confirm again; nothing was spent by this request.");
  const finished = () => fail("PAID_SYNC_OPERATION_FINISHED", "The operation this confirmation approved has already finished. A new paid sync needs a new confirmation; nothing was spent by this request.");
  if (!c) {
    if (!h) return { ok: true, cycleIds: [], boundCycleId: "" };
    if (superseding) return changed();
    if (terminal) return finished();
    return { ok: true, cycleIds: [hid], boundCycleId: hid };
  }
  if (claims.kind === "cont") {
    if (hid === c) return { ok: true, cycleIds: [c], boundCycleId: c };
    if (legacyChildOfBound) return { ok: true, cycleIds: [c, hid], boundCycleId: c };
    return changed();
  }
  if (hid === c) {
    if (terminal && claims.previewTerminal !== true) return finished();
    return { ok: true, cycleIds: [c], boundCycleId: c };
  }
  if (legacyChildOfBound) return { ok: true, cycleIds: [c, hid], boundCycleId: c };
  return changed();
}

// A stale snapshot is only safe to serve across a date rollover when it was
// produced by the current metric schema. A reportVersion bump means its
// payload shape or definitions changed, so an older payload must not masquerade
// as the new report.
export function staleSnapshotMatchesReportVersion(snapshot, reportVersion) {
  return snapshot?.params?.reportVersion === reportVersion;
}

// A stale snapshot may only be served across a date rollover when it belongs to the SAME scope as the request --
// not just the same report version. Daily Reporting is scoped by brand: an ALL-brand snapshot must never be
// served to a named-brand request (that would show the whole account under one brand's heading), nor the reverse.
// The as-of date (`to`) is deliberately NOT part of the scope -- rolling past it is the whole point of the stale
// path. Keys not listed impose no constraint, so reports that pass no staleScopeKeys keep the prior behaviour.
const BRAND_SCOPE_DEFAULT = "ALL";
function scopeValue(key, value) {
  if (key === "brand") { const b = value == null ? "" : String(value).trim(); return b || BRAND_SCOPE_DEFAULT; }
  return value == null ? "" : String(value);
}
export function pickStaleScope(params, keys) {
  const scope = {};
  for (const k of keys || []) scope[k] = scopeValue(k, params ? params[k] : undefined);
  return scope;
}
export function staleSnapshotMatchesScope(snapshot, params, keys) {
  if (!keys || !keys.length) return true;
  const sp = snapshot && snapshot.params ? snapshot.params : {};
  return keys.every((k) => scopeValue(k, sp[k]) === scopeValue(k, params ? params[k] : undefined));
}

function snapshotMeta(snapshot) {
  return {
    savedAt: snapshot.source_refreshed_at || snapshot.updated_at || null,
    updatedAt: snapshot.updated_at || null,
    bytes: Number(snapshot.payload_bytes || 0),
    shared: true,
  };
}

// Legacy reports were originally written before the shared store existed.
// They still build their payload in api/datadoe.js, so this small session API
// lets those builders claim the same lock and persist through the same schema
// without duplicating locking or Supabase writes in every route.
export async function beginSharedRefresh({
  res, reportKey, reportVersion, accountId, params, userId, label,
  lockSeconds = DEFAULT_LOCK_SECONDS, present = (payload) => payload,
}) {
  // WP10b: a route-owned live report can never open a refresh SESSION (lock + later save): refused typed BEFORE the
  // lock claim and BEFORE the caller's (possibly paid) builder can run. api/datadoe.js serves those read-only instead.
  assertNotRouteOwnedWrite(reportKey, "beginSharedRefresh");
  const paramsHash = paramsHashFor(reportVersion, params);
  if (!isSupabaseConfigured()) {
    return {
      finish(payload) {
        res.status(200).json({ ...present(payload), reportKey, reportVersion, paramsHash, shared: false });
      },
      release: async () => {},
    };
  }

  const locked = await claimRefreshLock({ reportKey, accountId, paramsHash, lockSeconds });
  if (!locked) {
    res.status(409).json({
      error: `${label} is already being refreshed for this account. Wait for that refresh to finish, then read the saved data â€” it does not need a second DataDoe export.`,
    });
    return null;
  }

  return {
    async finish(payload) {
      const serialised = JSON.stringify(payload);
      const payloadBytes = Buffer.byteLength(serialised, "utf8");
      if (payloadBytes > MAX_SNAPSHOT_BYTES) {
        throw new Error(`${label} produced ${(payloadBytes / (1024 * 1024)).toFixed(1)} MB, above the ${MAX_SNAPSHOT_BYTES / (1024 * 1024)} MB shared-snapshot limit. It was not saved. Narrow the scope (fewer days or a single brand) or aggregate this report further before relying on it.`);
      }
      assertNotRouteOwnedWrite(reportKey, "beginSharedRefresh.finish"); // belt and braces (the session was refused above)
      const saved = await saveReportSnapshot({
        reportKey,
        accountId,
        paramsHash,
        params: { reportVersion, ...params },
        payload,
        payloadBytes,
        sourceRefreshedAt: new Date().toISOString(),
      });
      if (saved?.id) {
        await publishSnapshotUpdate({ reportKey, accountId, paramsHash, snapshotId: saved.id }).catch(() => {});
      }
      res.status(200).json({
        ...present(payload),
        reportKey,
        reportVersion,
        paramsHash,
        snapshot: {
          savedAt: saved?.source_refreshed_at || new Date().toISOString(),
          updatedAt: saved?.updated_at || null,
          bytes: payloadBytes,
          shared: true,
          refreshedBy: userId || null,
        },
      });
    },
    release: () => releaseRefreshLock({ reportKey, accountId, paramsHash }).catch(() => {}),
  };
}

/**
 * Serve one report through the shared snapshot layer.
 *
 * @param {object} options
 * @param {object} options.res            Vercel response
 * @param {boolean} options.refresh       true only for an explicit Refresh
 * @param {string} options.reportKey      stable report identifier
 * @param {string} options.reportVersion  bump when the metric definition changes
 * @param {string} options.accountId      single selected account
 * @param {object} options.params         scope that identifies the snapshot
 * @param {string} options.userId         requesting user (audit only)
 * @param {string} options.label          human report name for messages
 * @param {() => Promise<object>} options.build  performs the DataDoe work
 * @param {(payload: object) => object} [options.present]  removes data the
 *        current user is not allowed to see after a shared payload is read
 */
export async function serveSharedReport({
  res, refresh, reportKey, reportVersion, accountId, params, userId, label, build,
  lockSeconds = DEFAULT_LOCK_SECONDS, present = (payload) => payload,
  // Optional TRUSTED ZERO-EXPORT durable re-derivation. When provided (Daily Reporting) and no compatible saved
  // snapshot exists on a READ, recompute the current-version payload from already-durable evidence and publish
  // it so the page auto-populates on this very visit -- still ZERO DataDoe. () => ({ payload, sourceRefreshedAt }
  // | { notReady, blockedBy? }). NEVER passed a DataDoe adapter, so it cannot create an export.
  deriveDurable = null,
  // Param keys that a stale (date-rolled) snapshot MUST match to be served -- e.g. ["brand"] for Daily, so a
  // named-brand read never falls back to the ALL-brand snapshot. Empty keeps the original report-version-only match.
  staleScopeKeys = [],
  // Injectable Supabase readers + self-heal store, so the full read path (including the brand-scoped stale fallback
  // and the durable self-heal) is provable offline. Production passes nothing and uses the module wrappers.
  readers = {}, store = undefined,
  // FRESHNESS (Brand View): the newest contributing-source provenance (ISO). When set, a served snapshot older
  // than it is flagged `updating:true` so the caller shows the last-known-good NOW and a zero-export rebuild is
  // known to be due (default null = the field is never added, behaviour byte-identical for every other report).
  contributingProvenanceAt = null,
  // FRESHNESS BY DEPENDENCY FINGERPRINT (Brand View, Defect B): the CURRENT dependency fingerprint of the COMPLETE
  // contributing set (brand-sales + inventory + Ads + mapping + catalog + version), computed identically to the
  // writer. When set and a served snapshot's recorded params.depFingerprint DIFFERS (either direction -- including
  // an optional dependency that became available/unavailable with unchanged brand-sales), the snapshot is stale:
  // serve the last-known-good NOW + `updating:true`, and the scheduler's next pass republishes (its fingerprint now
  // differs -> exactly one update). A stored snapshot WITH a matching fingerprint is fresh (the timestamp probe is
  // not applied); a stored snapshot WITHOUT a fingerprint (legacy row) falls back to the timestamp probe. Default
  // null = the fingerprint is never consulted (byte-identical for every other report).
  contributingDepFingerprint = null,
  // 504 GUARD (Brand View portfolio): when true, a READ never runs the potentially-slow `deriveDurable` inline
  // (the serverless-timeout source); a missing snapshot returns a typed `updating` state instead. The bounded
  // rebuild happens only on an explicit refresh (below). Default false keeps the inline self-heal for every
  // other report.
  deferRebuildOnRead = false,
  // Optional serve-time augmentation (Daily Reporting + Brand View): async ({ accountId, params, payload }) =>
  // extra response fields merged into a PAYLOAD-serving response only. Used to attach the current two-layer
  // `completeness` (provisional/final + itemization) read live from source_oli_completeness -- always fresh, never
  // stored in the snapshot, never on a snapshotMissing/updating-only response. Default null = never added.
  augmentResponse = null,
  // When set (a makeRouteDeadline handle), the REFRESH build is bounded: on ROUTE_DEADLINE_EXCEEDED the caller
  // serves the last-known-good + `updating:true` (HTTP 200), never a 504. Default null = unbounded (unchanged).
  routeDeadline = null,
  // FRESHNESS-BY-COVERAGE-ADVANCE (Daily Reporting): the account's CURRENT latest proven durable date (YYYY-MM-DD).
  // When set and a found snapshot's own as-of (`params.to`) is BEFORE it, the snapshot is stale-by-source-advance:
  // re-derive via `deriveDurable` (self-heal, ZERO DataDoe) instead of serving it, so a NAMED-brand snapshot
  // refreshes the moment the ACCOUNT's proven OLI/completeness horizon advances -- even though the brand itself had
  // no new activity (the horizon is account-level, never the brand's last sale). The self-heal is serialized by the
  // existing refresh lock, persists under the honest EFFECTIVE (clamped) identity, and on a not-ready derive it
  // falls back to serving the found snapshot as last-known-good (never a blank page). Default null = unchanged for
  // every other report (they never pass it, so the stale-scope/exact behaviour is byte-identical).
  staleWhenParamsToBefore = null,
  // WP10b fix (P3-5) -- READ-ONLY BUILD ON AN EXPLICIT RELOAD (Brand View single + portfolio refresh=1 only). When true
  // AND `deriveDurable` is supplied, a read whose EXACT snapshot is missing first derives the requested identity from
  // saved evidence and SERVES it via the read-only self-heal (no lock, no save, no publish, no DataDoe -- the builders
  // only read saved snapshots); a not-ready/failed derive falls through to the unchanged last-known-good / missing
  // states. An existing exact row is served exactly as before. Default false => byte-identical for every caller.
  readOnlyBuildOnMissingExact = false,
  // ATTRIBUTION-REVISION FRESHNESS (Daily Reporting NAMED brand): the account's CURRENT campaign->brand mapping
  // revision. When set and a found NAMED-brand snapshot recorded a DIFFERENT (or no) `campaignMappingRev`, the
  // snapshot's ad attribution is stale (a campaign was assigned/cleared/reassigned since it was derived): re-derive
  // via `deriveDurable` (ZERO DataDoe) so the named brand's ads reflect the current mapping immediately -- WITHOUT
  // touching account-level All-Brands totals (which never carry a rev and never pass this). Default null = unchanged.
  staleWhenMappingRev = null,
}) {
  // WP10b READ-ONLY REFRESH (structural, no flag): a refresh of a ROUTE-OWNED live report is served as a READ -- the
  // latest published row (or the existing read-only durable derive) with NO lock, NO build (the build may be a paid
  // DataDoe export), NO snapshot write. api/datadoe.js already passes refresh:false for these keys; this is the backstop
  // so no caller can ever reach the refresh write path below for a route-owned key.
  if (refresh && isRouteOwnedLiveReportKey(reportKey)) refresh = false;
  const paramsHash = paramsHashFor(reportVersion, params);
  // A found snapshot is stale-by-coverage-advance when the account's proven horizon has moved past the snapshot's
  // own as-of (`params.to`). Gated on `staleWhenParamsToBefore` (only Daily supplies it) + a durable re-derivation.
  const paramsToBehindProven = (snap) => {
    if (!staleWhenParamsToBefore || !snap || !snap.params) return false;
    const snapTo = snap.params.to != null ? String(snap.params.to) : "";
    return !!snapTo && snapTo < String(staleWhenParamsToBefore);
  };
  // A found NAMED-brand snapshot is stale-by-mapping when the account's campaign->brand mapping revision differs from
  // (or is absent on) the snapshot. A payload is inline for Daily so the recorded rev is available; if unavailable the
  // check is skipped (fail-soft, never a rebuild loop). Only the named-brand Daily serve supplies staleWhenMappingRev.
  const mappingRevStale = (snap) => {
    if (!staleWhenMappingRev || !snap || !snap.payload || typeof snap.payload !== "object") return false;
    if (!Array.isArray(snap.payload.rows)) return false; // not an inline daily payload -> cannot compare, skip
    return String(snap.payload.campaignMappingRev || "") !== String(staleWhenMappingRev);
  };
  // Null-safe source-staleness probe: a served snapshot whose source provenance predates the newest contributing
  // provenance is stale (a rebuild is due). Returns false whenever nothing was supplied (never fabricates).
  const isSourceStale = (snap) => {
    if (!snap) return false;
    // Dependency-fingerprint staleness (Defect B): a mismatch in EITHER direction means the complete dependency
    // set changed (an optional dependency became available/unavailable, Ads advanced, a mapping was edited) even
    // when brand-sales provenance is unchanged. A present-and-equal fingerprint is authoritatively fresh (the
    // timestamp probe is skipped); a legacy snapshot with no stored fingerprint falls back to the timestamp probe.
    if (contributingDepFingerprint) {
      const stored = String(snap.params?.depFingerprint || "");
      if (stored) return stored !== String(contributingDepFingerprint);
    }
    if (!contributingProvenanceAt) return false;
    const snapAt = String(snap.source_refreshed_at || snap.updated_at || "");
    return !!snapAt && snapAt < String(contributingProvenanceAt);
  };
  const readSnapshot = readers.getReportSnapshot || getReportSnapshot;
  const readLatest = readers.getLatestReportSnapshot || getLatestReportSnapshot;
  const readLatestForScope = readers.getLatestReportSnapshotForScope || getLatestReportSnapshotForScope;

  // Without Supabase there is no shared store. Refresh still works so the app
  // remains usable in a local environment, but it is reported as unshared
  // rather than pretending the result was saved for everyone.
  if (!isSupabaseConfigured()) {
    if (!refresh) {
      res.status(200).json({
        snapshotMissing: true,
        reportKey, reportVersion, accountId, paramsHash,
        message: `${label} has no shared saved data because Supabase is not configured in this deployment.`,
      });
      return;
    }
    const payload = await build();
    res.status(200).json({ ...present(payload), reportKey, reportVersion, paramsHash, shared: false });
    return;
  }

  if (!refresh) {
    const snapshot = await readSnapshot({ reportKey, accountId, paramsHash });
    if (snapshot && snapshot.payload) {
      // Stale-by-coverage-advance (Daily named-brand): the account's proven horizon moved past this snapshot's
      // as-of -> re-derive via the durable self-heal (ZERO DataDoe) instead of serving an out-of-date as-of. On a
      // not-ready derive the self-heal returns un-served and we fall through to serve THIS snapshot as LKG.
      if ((paramsToBehindProven(snapshot) || mappingRevStale(snapshot)) && deriveDurable && !deferRebuildOnRead) {
        const healed = await selfHealFromDurable({ deriveDurable, reportKey, reportVersion, accountId, paramsHash, params, present, res, label, lockSeconds, augmentResponse, readOnly: true }, store);
        if (healed.served) return;
      }
      // The EXACT snapshot exists. If the contributing sources have advanced past it (e.g. brand-sales rolled
      // 21 -> 25 Aug under the same asOf), serve it NOW but flag `updating` so a zero-export rebuild is triggered.
      const updating = isSourceStale(snapshot);
      // servedTo = the window this snapshot was actually derived for, so the completeness augment can clamp its
      // freshness label to the served values (never label older values with a newer finalized-through date).
      const extra = augmentResponse ? await augmentResponse({ accountId, params, payload: snapshot.payload, servedTo: snapshot.params && snapshot.params.to != null ? String(snapshot.params.to) : null }) : {};
      res.status(200).json({
        ...present(snapshot.payload),
        reportKey, reportVersion, paramsHash,
        ...(updating ? { updating: true } : {}),
        ...(extra && typeof extra === "object" ? extra : {}),
        snapshot: snapshotMeta(snapshot),
      });
      return;
    }

    // WP10b fix (P3-5): an explicit reload of a brand / as-of that has NO published row builds it READ-ONLY from saved
    // evidence (served, never stored). Only callers that opt in (Brand View refresh=1) reach this; zero writes.
    let readOnlyBuild = null;
    if (readOnlyBuildOnMissingExact && deriveDurable) {
      readOnlyBuild = await selfHealFromDurable({ deriveDurable, reportKey, reportVersion, accountId, paramsHash, params, present, res, label, lockSeconds, augmentResponse, readOnly: true }, store);
      if (readOnlyBuild.served) return;
    }

    // Every report's scope includes its as-of date, so the exact key stops
    // matching the moment the date rolls over. Rather than show a blank report
    // every morning, serve the most recent saved snapshot for this report and
    // account and label it with the scope it was actually saved for. The stale
    // flag is what lets the UI say "this is yesterday's report" instead of
    // implying it is current. When staleScopeKeys is set the fallback is
    // narrowed to the SAME scope (e.g. brand), so a named-brand read cannot be
    // answered with the ALL-brand snapshot.
    const latest = staleScopeKeys.length
      ? await readLatestForScope({ reportKey, accountId, reportVersion, scope: pickStaleScope(params, staleScopeKeys) })
      : await readLatest({ reportKey, accountId });
    if (latest && latest.payload
        && staleSnapshotMatchesReportVersion(latest, reportVersion)
        && staleSnapshotMatchesScope(latest, params, staleScopeKeys)) {
      // Stale-by-coverage-advance (Daily named-brand): if the account's proven horizon moved past this snapshot's
      // as-of, re-derive via the durable self-heal (ZERO DataDoe) so the named-brand horizon tracks the account's,
      // not the brand's last sale. On a not-ready derive, fall through to serving this snapshot as LKG (stale-scope).
      if ((paramsToBehindProven(latest) || mappingRevStale(latest)) && deriveDurable && !deferRebuildOnRead) {
        const healed = await selfHealFromDurable({ deriveDurable, reportKey, reportVersion, accountId, paramsHash, params, present, res, label, lockSeconds, augmentResponse, readOnly: true }, store);
        if (healed.served) return;
      }
      // A last-known-good for a DIFFERENT params hash (across-day / changed account set) is itself a stale
      // scope; when a rebuild is deferred (Brand View portfolio) OR the sources advanced past it, flag updating
      // so the caller shows this LKG NOW and polls until the rebuild republishes the exact-identity snapshot.
      const updating = deferRebuildOnRead || isSourceStale(latest);
      // servedTo = the (older, stale-scope) window this LKG snapshot was derived for: the completeness label is
      // clamped to it so a Sep-17 LKG can never be stapled with a Sep-20 "Final through" freshness (invariant #8).
      const extra = augmentResponse ? await augmentResponse({ accountId, params, payload: latest.payload, servedTo: latest.params && latest.params.to != null ? String(latest.params.to) : null }) : {};
      res.status(200).json({
        ...present(latest.payload),
        reportKey, reportVersion, paramsHash,
        ...(updating ? { updating: true } : {}),
        ...(extra && typeof extra === "object" ? extra : {}),
        snapshot: {
          ...snapshotMeta(latest),
          staleScope: true,
          savedForParams: latest.params || null,
          requestedParams: { reportVersion, ...params },
        },
      });
      return;
    }

    // WP10b fix (P3-5): the opt-in read-only build already ran above and could not produce the payload (not ready /
    // bounded-deadline expiry) and no last-known-good exists -> the honest typed "waiting" state (never a write).
    if (readOnlyBuild && readOnlyBuild.notReady) {
      res.status(200).json({
        snapshotMissing: true, ...(deferRebuildOnRead ? { updating: true } : {}), reportKey, reportVersion, accountId, paramsHash,
        waitingForScheduledData: true, missingSources: readOnlyBuild.missingSources || [], message: readOnlyBuild.message,
      });
      return;
    }

    // 504 GUARD: a slow full-portfolio rebuild must NOT run inline on a read. When deferRebuildOnRead is set and
    // no snapshot exists at all, return a typed `updating` state (never a blank fatal error); the frontend shows
    // the updating state and triggers the bounded rebuild via an explicit refresh.
    if (deferRebuildOnRead) {
      res.status(200).json({
        snapshotMissing: true, updating: true,
        reportKey, reportVersion, accountId, paramsHash,
        message: `${label} is being prepared from saved data. It will appear here shortly — no export is created.`,
      });
      return;
    }

    // No exact + no compatible stale snapshot. If a trusted zero-export durable re-derivation exists for this
    // report, recompute the current-version payload from durable evidence and publish it NOW (still zero DataDoe),
    // so a normal page visit auto-populates instead of showing "Nothing saved" while durable evidence is present.
    // (Skipped when the opt-in read-only build above already attempted this exact derive.)
    if (deriveDurable && !readOnlyBuild) {
      const healed = await selfHealFromDurable({
        deriveDurable, reportKey, reportVersion, accountId, paramsHash, params, present, res, label, lockSeconds, augmentResponse, readOnly: true,
      }, store);
      if (healed.served) return;
      if (healed.notReady) {
        res.status(200).json({
          snapshotMissing: true, reportKey, reportVersion, accountId, paramsHash,
          waitingForScheduledData: true,
          missingSources: healed.missingSources || [],
          message: healed.message,
        });
        return;
      }
      // Concurrent re-derivation in flight (lock held elsewhere) and not yet landed: fall through to the honest
      // "not saved yet" state; the in-flight derivation will publish it for the next read.
    }

    res.status(200).json({
      snapshotMissing: true,
      reportKey, reportVersion, accountId, paramsHash,
      message: `No saved ${label} for this account yet — waiting for the scheduled data refresh.`,
    });
    return;
  }

  assertNotRouteOwnedWrite(reportKey, "serveSharedReport refresh"); // unreachable for a route-owned key (coerced above)
  const locked = await claimRefreshLock({ reportKey, accountId, paramsHash, lockSeconds });
  if (!locked) {
    res.status(409).json({
      error: `${label} is already being refreshed for this account. Wait for that refresh to finish, then read the saved data — it does not need a second DataDoe export.`,
    });
    return;
  }

  try {
    let payload;
    try {
      payload = await build();
    } catch (e) {
      // BOUNDED rebuild: on a route-deadline expiry, serve the last-known-good + `updating` (HTTP 200) so the
      // page never blanks with a 504. The frontend polls; a later pass republishes the exact-identity snapshot.
      if (routeDeadline && routeDeadline.isDeadlineError && routeDeadline.isDeadlineError(e)) {
        const lkg = staleScopeKeys.length
          ? await readLatestForScope({ reportKey, accountId, reportVersion, scope: pickStaleScope(params, staleScopeKeys) })
          : await readLatest({ reportKey, accountId });
        if (lkg && lkg.payload) {
          res.status(200).json({
            ...present(lkg.payload),
            reportKey, reportVersion, paramsHash, updating: true,
            snapshot: { ...snapshotMeta(lkg), staleScope: lkg.params_hash !== paramsHash, rebuildDeferred: true },
          });
        } else {
          res.status(200).json({
            snapshotMissing: true, updating: true, reportKey, reportVersion, accountId, paramsHash,
            message: `${label} is still being prepared from saved data. It will appear here shortly — no export is created.`,
          });
        }
        return;
      }
      throw e;
    }
    const serialised = JSON.stringify(payload);
    const payloadBytes = Buffer.byteLength(serialised, "utf8");
    if (payloadBytes > MAX_SNAPSHOT_BYTES) {
      throw new Error(`${label} produced ${(payloadBytes / (1024 * 1024)).toFixed(1)} MB, above the ${MAX_SNAPSHOT_BYTES / (1024 * 1024)} MB shared-snapshot limit. It was not saved. Narrow the scope (fewer days or a single brand) or aggregate this report further before relying on it.`);
    }
    const saved = await saveReportSnapshot({
      reportKey,
      accountId,
      paramsHash,
      params: { reportVersion, ...params },
      payload,
      payloadBytes,
      sourceRefreshedAt: new Date().toISOString(),
    });
    if (saved?.id) {
      // Only a tiny row is broadcast; report payloads never travel on Realtime.
      await publishSnapshotUpdate({ reportKey, accountId, paramsHash, snapshotId: saved.id }).catch(() => {});
    }
    res.status(200).json({
      ...present(payload),
      reportKey, reportVersion, paramsHash,
      snapshot: {
        savedAt: saved?.source_refreshed_at || new Date().toISOString(),
        updatedAt: saved?.updated_at || null,
        bytes: payloadBytes,
        shared: true,
        refreshedBy: userId || null,
      },
    });
  } finally {
    await releaseRefreshLock({ reportKey, accountId, paramsHash }).catch(() => {});
  }
}

// Friendly names for the durable sources a re-derivation can be blocked on (for the "waiting" message).
const SOURCE_LABELS = {
  "order-line-items": "Order Line Items sales history",
  "product-catalog": "Product Catalog",
  "ads-asin-date": "Amazon Ads (ASIN)",
};
function describeMissingSources(blockedBy) {
  const keys = [...new Set((Array.isArray(blockedBy) ? blockedBy : [])
    // Only sources that actually block the report (sales) matter for the "waiting" state; an Ads-only gap
    // never blocks -- the report still shows sales with Ads typed unavailable.
    .filter((b) => b && b.blocksSales)
    .map((b) => b.sourceKey))];
  return keys.map((k) => SOURCE_LABELS[k] || k);
}

function serveSnapshotJson(res, snapshot, { reportKey, reportVersion, paramsHash, present, extra = {} }) {
  res.status(200).json({
    ...present(snapshot.payload),
    reportKey, reportVersion, paramsHash,
    snapshot: { ...snapshotMeta(snapshot), ...extra },
  });
}

// The default durable store the self-heal writes through (injectable for offline tests).
const DEFAULT_STORE = { claimRefreshLock, releaseRefreshLock, getReportSnapshot, saveReportSnapshot, publishSnapshotUpdate };

// Persist a payload produced by a trusted zero-export re-derivation under the EXACT live identity, and broadcast
// the compact update event. Mirrors beginSharedRefresh.finish's write, minus any DataDoe involvement.
async function persistDerivedSnapshot({ reportKey, reportVersion, accountId, paramsHash, params, payload, sourceRefreshedAt, label }, store = DEFAULT_STORE) {
  // WP10b: a route-owned live key is never persisted by the serve-side self-heal (the fenced publisher owns it).
  assertNotRouteOwnedWrite(reportKey, "persistDerivedSnapshot");
  const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (payloadBytes > MAX_SNAPSHOT_BYTES) {
    throw new Error(`${label} re-derived ${(payloadBytes / (1024 * 1024)).toFixed(1)} MB, above the ${MAX_SNAPSHOT_BYTES / (1024 * 1024)} MB shared-snapshot limit; it was not saved.`);
  }
  const saved = await store.saveReportSnapshot({
    reportKey, accountId, paramsHash,
    params: { reportVersion, ...params },
    payload, payloadBytes,
    sourceRefreshedAt: sourceRefreshedAt || new Date().toISOString(),
  });
  if (saved?.id) await store.publishSnapshotUpdate({ reportKey, accountId, paramsHash, snapshotId: saved.id }).catch(() => {});
  return {
    savedAt: saved?.source_refreshed_at || sourceRefreshedAt || new Date().toISOString(),
    updatedAt: saved?.updated_at || null,
    payload_bytes: payloadBytes,
  };
}

/**
 * Trusted ZERO-EXPORT self-heal for a read whose snapshot is missing. Serializes on the SAME refresh lock so a
 * burst of concurrent page loads produces exactly ONE re-derivation/save; the losers re-read (and serve if it has
 * landed). Returns { served } | { served:false, notReady, missingSources, message } | { served:false } (a
 * concurrent derivation is in flight but not yet saved -> caller shows the honest "not saved yet" state).
 * `store` is injectable so the concurrency + zero-export contract is provable offline.
 */
export async function selfHealFromDurable({ deriveDurable, reportKey, reportVersion, accountId, paramsHash, params, present = (p) => p, res, label, lockSeconds, augmentResponse = null, readOnly = false }, store = DEFAULT_STORE) {
  // WP10b: a ROUTE-OWNED live key only ever takes the read-only derive-and-serve branch (never lock / persist / publish),
  // whatever the caller passed -- the fenced publisher is its only writer.
  if (!readOnly && isRouteOwnedLiveReportKey(reportKey)) readOnly = true;
  // Two-layer completeness for the self-heal serve (first visit before a scheduled publish). Advisory; the augment
  // returns {} on any failure, so it never breaks the self-heal.
  const augExtra = augmentResponse ? await augmentResponse({ accountId, params }) : {};
  const withAug = (extra) => ({ ...extra, ...(augExtra && typeof augExtra === "object" ? augExtra : {}) });

  // PHASE 3 READ-ONLY GET (production default for every serve path). Derive the payload from ALREADY-DURABLE evidence
  // and SERVE it, but NEVER claim a lock, persist a snapshot, or publish an update -- opening a page must perform zero
  // backend mutations. The scheduler owns materialization; this is the zero-write fallback for an identity that is not
  // yet materialized (e.g. a named-brand Daily whose window tracks the viewer's marketplace-today). A not-ready derive
  // degrades to the honest "waiting" state (never a 500, never a fabricated value, never a write).
  if (readOnly) {
    let derived = null;
    try { derived = await deriveDurable(); }
    catch (_e) { return { served: false, notReady: true, missingSources: [], message: `Waiting for the scheduled data refresh before ${label} can be shown. No fabricated values are displayed and no export is created.` }; }
    if (!derived || !derived.payload) {
      const missingSources = describeMissingSources(derived && derived.blockedBy);
      const named = missingSources.length ? ` (waiting for: ${missingSources.join(", ")})` : "";
      return { served: false, notReady: true, missingSources, message: `Waiting for the scheduled data refresh before ${label} can be shown${named}. No fabricated values are displayed and no export is created.` };
    }
    // A clamped as-of is served under its honest EFFECTIVE identity, exactly like the persisted path -- just not stored.
    const effectiveParams = derived.effectiveParams || null;
    const effectiveHash = effectiveParams ? paramsHashFor(reportVersion, effectiveParams) : paramsHash;
    const clamped = effectiveParams && effectiveHash !== paramsHash;
    res.status(200).json({
      ...present(derived.payload),
      reportKey, reportVersion, paramsHash: effectiveHash,
      ...(augExtra && typeof augExtra === "object" ? augExtra : {}),
      snapshot: {
        savedAt: derived.sourceRefreshedAt || null, updatedAt: null, shared: true, rederived: true, readOnly: true,
        ...(clamped ? { staleScope: true, savedForParams: { reportVersion, ...effectiveParams }, requestedParams: { reportVersion, ...params } } : {}),
      },
    });
    return { served: true };
  }

  const locked = await store.claimRefreshLock({ reportKey, accountId, paramsHash, lockSeconds });
  if (!locked) {
    // Another request already holds the lock and is re-deriving this exact snapshot. Never derive twice; re-read
    // once and serve it if it has already landed, otherwise report missing for this read.
    const snap = await store.getReportSnapshot({ reportKey, accountId, paramsHash });
    if (snap && snap.payload) { serveSnapshotJson(res, snap, { reportKey, reportVersion, paramsHash, present, extra: withAug({ rederived: true }) }); return { served: true }; }
    return { served: false };
  }
  try {
    // Double-check inside the lock: the race winner may have just published it.
    const existing = await store.getReportSnapshot({ reportKey, accountId, paramsHash });
    if (existing && existing.payload) { serveSnapshotJson(res, existing, { reportKey, reportVersion, paramsHash, present, extra: withAug({ rederived: true }) }); return { served: true }; }

    // A re-derivation FAILURE (e.g. an unreadable durable source or a row-limit) must degrade to the honest
    // "waiting" state on a READ -- never a 500 and never a fabricated value.
    let derived = null;
    try { derived = await deriveDurable(); }
    catch (e) { return { served: false, notReady: true, missingSources: [], message: `Waiting for the scheduled data refresh before ${label} can be shown. No fabricated values are displayed and no export is created.` }; }
    if (!derived || !derived.payload) {
      const missingSources = describeMissingSources(derived && derived.blockedBy);
      const named = missingSources.length ? ` (waiting for: ${missingSources.join(", ")})` : "";
      return {
        served: false, notReady: true, missingSources,
        message: `Waiting for the scheduled data refresh before ${label} can be shown${named}. No fabricated values are displayed and no export is created.`,
      };
    }
    // If the re-derivation CLAMPED the requested as-of down to the account's latest proven date, the honest
    // identity is the effective window (from, to=latest-proven, brand), NOT the requested one. Persist under that
    // identity so the row's params_hash matches its params (provenance stays exact) and serve it clearly labelled
    // as an earlier as-of -- exactly like the stale path -- rather than pretending it covers the requested date.
    const effectiveParams = derived.effectiveParams || null;
    const effectiveHash = effectiveParams ? paramsHashFor(reportVersion, effectiveParams) : paramsHash;
    const clamped = effectiveParams && effectiveHash !== paramsHash;
    const persistParams = clamped ? effectiveParams : params;
    const saved = await persistDerivedSnapshot({ reportKey, reportVersion, accountId, paramsHash: effectiveHash, params: persistParams, payload: derived.payload, sourceRefreshedAt: derived.sourceRefreshedAt, label }, store);
    res.status(200).json({
      ...present(derived.payload),
      reportKey, reportVersion, paramsHash: effectiveHash,
      ...(augExtra && typeof augExtra === "object" ? augExtra : {}),
      snapshot: {
        savedAt: saved.savedAt, updatedAt: saved.updatedAt, bytes: saved.payload_bytes, shared: true, rederived: true,
        ...(clamped ? { staleScope: true, savedForParams: { reportVersion, ...effectiveParams }, requestedParams: { reportVersion, ...params } } : {}),
      },
    });
    return { served: true };
  } finally {
    await store.releaseRefreshLock({ reportKey, accountId, paramsHash }).catch(() => {});
  }
}
