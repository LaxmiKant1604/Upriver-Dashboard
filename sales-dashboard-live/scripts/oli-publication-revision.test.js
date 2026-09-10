// Pure durable OLI revision identity + reconciliation classifier (WORK 3 + WORK 11 items 10/11/12/13/14).
// Offline + pure. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { computeOliAccountRevision, classifyOliReportTarget, liveSnapshotAsOf, oliRevisionCoveredByJob, jobIsPromotable, evaluatePublicationBinding, stableJson, OLI_PUBLICATION_STATE } from "../lib/server/sync/oli-publication-revision.js";
import { OLI_LINEAGE_STATUS } from "../lib/server/sync/source-durable-model.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "oli-publication-revision\n");

const START = "2025-01-01";
const ASOF = "2026-09-09";
const base = { organizationFingerprint: "org-1", connectionId: "primary", oliStart: START, requestedAsOf: ASOF };

// ---- computeOliAccountRevision ----
// (item 10) POSITIVE-row OLI revision is bound + deterministic.
const posA = computeOliAccountRevision({ ...base, accountId: "A01", positiveHashes: ["h-a", "h-b"] });
ok("positive-row account is eligible (nonempty) with a 32-hex revisionId + sorted deps", posA.eligible === true && posA.status === OLI_LINEAGE_STATUS.NONEMPTY && /^[0-9a-f]{32}$/.test(posA.revisionId) && JSON.stringify(posA.deps) === JSON.stringify(["h-a", "h-b"]));
const posA2 = computeOliAccountRevision({ ...base, accountId: "A01", positiveHashes: ["h-b", "h-a"] });
ok("the revision is DETERMINISTIC (hash order does not matter; same inputs -> same revisionId)", posA2.revisionId === posA.revisionId);

// (item 11) PROVEN-ZERO OLI revision publishes honest zero sales (eligible via the zero-row export chain).
const empty = computeOliAccountRevision({ ...base, accountId: "A02", positiveHashes: [], zeroRowExports: [{ requestHash: "z-1", from: START, to: ASOF }] });
ok("proven-empty account (zero-row export covering [oliStart..asOf]) is eligible with a revisionId", empty.eligible === true && empty.status === OLI_LINEAGE_STATUS.PROVEN_EMPTY && /^[0-9a-f]{32}$/.test(empty.revisionId) && empty.deps[0] === "z-1");

// (item 12) MISSING / malformed / incomplete provenance defers WITHOUT a fabricated hash.
const missing = computeOliAccountRevision({ ...base, accountId: "A03", positiveHashes: [], zeroRowExports: [] });
ok("no positive rows + no zero-row proof -> NOT eligible, revisionId null (never fabricated)", missing.eligible === false && missing.revisionId === null && missing.status === OLI_LINEAGE_STATUS.MISSING);
const blankHash = computeOliAccountRevision({ ...base, accountId: "A04", positiveHashes: ["", null] });
ok("a positive row with a blank/missing request hash -> NOT eligible (never a fabricated hash)", blankHash.eligible === false && blankHash.revisionId === null);
const gap = computeOliAccountRevision({ ...base, accountId: "A05", positiveHashes: [], zeroRowExports: [{ requestHash: "z", from: "2025-06-01", to: ASOF }] });
ok("a zero-row export that leaves a GAP before oliStart -> NOT eligible (coverage alone never sufficient)", gap.eligible === false && gap.revisionId === null);
const badBoundary = computeOliAccountRevision({ organizationFingerprint: "", accountId: "A06", oliStart: START, requestedAsOf: ASOF, positiveHashes: ["h"] });
ok("an incomplete account boundary (blank organizationFingerprint) -> NOT eligible", badBoundary.eligible === false && badBoundary.reason === "incomplete-account-boundary");

// (item 13) NO cross-account provenance borrowing: A01's revision uses ONLY its own hashes; a different account with
// the SAME hashes still gets a DIFFERENT revisionId (the account boundary is part of the identity).
const posB = computeOliAccountRevision({ ...base, accountId: "B01", positiveHashes: ["h-a", "h-b"] });
ok("a DIFFERENT account with identical hashes gets a DIFFERENT revisionId (no cross-account borrowing)", posB.revisionId !== posA.revisionId);
const diffOrg = computeOliAccountRevision({ ...base, organizationFingerprint: "org-2", accountId: "A01", positiveHashes: ["h-a", "h-b"] });
ok("a different organizationFingerprint gets a different revisionId (complete org+account boundary)", diffOrg.revisionId !== posA.revisionId);
const diffConn = computeOliAccountRevision({ ...base, connectionId: "secondary", accountId: "A01", positiveHashes: ["h-a", "h-b"] });
ok("a different connectionId gets a different revisionId", diffConn.revisionId !== posA.revisionId);

// (item 14 support) A CORRECTED re-export (different request hashes, same as-of) is a DIFFERENT revision.
const corrected = computeOliAccountRevision({ ...base, accountId: "A01", positiveHashes: ["h-a", "h-c"] });
ok("a corrected re-export (different request hashes) yields a DIFFERENT revisionId (content identity, not updated_at)", corrected.revisionId !== posA.revisionId);

// ---- classifyOliReportTarget ----
const live = (to) => ({ report_key: "daily-reporting", account_id: "A01", params_hash: "ph", params: { to } });
ok("liveSnapshotAsOf reads the content as-of from params.to (never updated_at)", liveSnapshotAsOf(live("2026-09-09")) === "2026-09-09" && liveSnapshotAsOf({}) === "");

// posA.deps === ["h-a","h-b"]. A job whose depends_on CONTAINS both (plus catalog) COVERS the revision; a job missing
// one (a corrected/added export hash) does NOT.
const jobCovers = { validated: true, dependsOn: ["h-a", "h-b", "catalog-1"] };
const jobStale = { validated: true, dependsOn: ["h-a", "catalog-1"] }; // h-b missing -> OLI advanced
const jobUnvalidated = { validated: false, dependsOn: ["h-a", "h-b"] };
ok("oliRevisionCoveredByJob: a validated job whose depends_on contains every current OLI hash -> covered", oliRevisionCoveredByJob(posA, jobCovers) === true);
ok("oliRevisionCoveredByJob: a job MISSING a current OLI hash -> NOT covered (OLI advanced)", oliRevisionCoveredByJob(posA, jobStale) === false);
ok("oliRevisionCoveredByJob: an UNVALIDATED job -> NOT covered", oliRevisionCoveredByJob(posA, jobUnvalidated) === false);
ok("oliRevisionCoveredByJob: a missing job -> NOT covered (fail toward re-deriving)", oliRevisionCoveredByJob(posA, null) === false);
ok("oliRevisionCoveredByJob: an ineligible revision is never covered", oliRevisionCoveredByJob(missing, jobCovers) === false);

ok("not eligible -> DEFERRED_PROVENANCE (never publish)", classifyOliReportTarget({ revision: missing, liveSnapshot: null, requestedAsOf: ASOF, jobLineage: null }).state === OLI_PUBLICATION_STATE.DEFERRED_PROVENANCE);
ok("eligible + no live snapshot -> STALE live-missing", (() => { const c = classifyOliReportTarget({ revision: posA, liveSnapshot: null, requestedAsOf: ASOF, jobLineage: jobCovers }); return c.state === OLI_PUBLICATION_STATE.STALE && c.reason === "live-missing"; })());
ok("eligible + live built for an OLDER as-of -> STALE live-older-asof (durable OLI advanced)", (() => { const c = classifyOliReportTarget({ revision: posA, liveSnapshot: live("2026-09-07"), readbackOk: true, requestedAsOf: ASOF, jobLineage: jobCovers }); return c.state === OLI_PUBLICATION_STATE.STALE && c.reason === "live-older-asof"; })());
// (blocker 3) SAME as-of + NEW OLI hash (job missing it) -> stale/reconcile, even with a verified readback.
ok("SAME date + NEW OLI hash (job lineage stale) -> STALE oli-revision-changed", (() => { const c = classifyOliReportTarget({ revision: posA, liveSnapshot: live(ASOF), readbackOk: true, requestedAsOf: ASOF, jobLineage: jobStale }); return c.state === OLI_PUBLICATION_STATE.STALE && c.reason === "oli-revision-changed"; })());
ok("eligible + live at the as-of + covered but readback FAILS -> STALE live-unverified", (() => { const c = classifyOliReportTarget({ revision: posA, liveSnapshot: live(ASOF), readbackOk: false, requestedAsOf: ASOF, jobLineage: jobCovers }); return c.state === OLI_PUBLICATION_STATE.STALE && c.reason === "live-unverified"; })());
// (blocker 3) SAME date + SAME hash (job covers) + verified -> no-op.
ok("SAME date + SAME OLI hash (job covers) + verified -> PUBLICATION_NOT_REQUIRED (no-op)", classifyOliReportTarget({ revision: posA, liveSnapshot: live(ASOF), readbackOk: true, requestedAsOf: ASOF, jobLineage: jobCovers }).state === OLI_PUBLICATION_STATE.PUBLICATION_NOT_REQUIRED);
ok("a live snapshot with NO readable as-of is STALE (never trusted as current)", classifyOliReportTarget({ revision: posA, liveSnapshot: { params: {} }, readbackOk: true, requestedAsOf: ASOF, jobLineage: jobCovers }).state === OLI_PUBLICATION_STATE.STALE);

// ---- jobIsPromotable + evaluatePublicationBinding (blockers 1/2: EXACT publication binding, not depends_on trust) ----
const goodJob = { deriveStatus: "succeeded", saveStatus: "succeeded", validated: true, cycleStatus: "succeeded", snapshotParamsHash: "sh1", dependsOn: ["h-a", "h-b", "catalog"] };
ok("jobIsPromotable: succeeded+succeeded+validated+terminal+nonblank-hash", jobIsPromotable(goodJob) === true);
ok("jobIsPromotable: rejects unvalidated / not-succeeded / running cycle / blank hash", !jobIsPromotable({ ...goodJob, validated: false }) && !jobIsPromotable({ ...goodJob, deriveStatus: "failed" }) && !jobIsPromotable({ ...goodJob, saveStatus: "failed" }) && !jobIsPromotable({ ...goodJob, cycleStatus: "running" }) && !jobIsPromotable({ ...goodJob, snapshotParamsHash: "" }));

// Fake shared publisher contract + hash for the pure binding tests.
const C = { liveReportKey: "daily-reporting", liveReportVersion: "dr-live", liveParams: (p) => ({ to: p.to }) };
const H = (v, params) => v + "|" + stableJson(params);
const shadow = { params_hash: "sh1", params: { reportVersion: "dr/shadow", accountId: "A01", to: ASOF }, source_refreshed_at: "2026-09-09T05:00:00Z" };
const shadowPay = { rows: [{ d: 1 }] };
const candHash = H(C.liveReportVersion, C.liveParams(shadow.params)); // liveParams uses only {to}
const liveMatch = { report_key: "daily-reporting", account_id: "A01", params_hash: candHash, params: { reportVersion: "dr-live", to: ASOF }, source_refreshed_at: "2026-09-09T05:00:00Z" };
const bind = (over = {}) => evaluatePublicationBinding({ revision: posA, accountId: "A01", job: goodJob, shadow, hydratedShadowPayload: shadowPay, live: liveMatch, hydratedLivePayload: shadowPay, contract: C, computeHash: H, ...over });

ok("BINDING: live proven equal to the exact shadow candidate (identity + source_refreshed_at + params + payload) -> PUBLICATION_NOT_REQUIRED", bind().state === OLI_PUBLICATION_STATE.PUBLICATION_NOT_REQUIRED);
// (blocker 1) valid live at the same as-of + a newer validated job whose shadow was NOT promoted -> the live's
// source_refreshed_at differs from the job's shadow -> STALE (until that exact candidate is promoted).
ok("BINDING blocker 1: an UNPROMOTED newer job (live source_refreshed_at differs) -> STALE (never PUBLICATION_NOT_REQUIRED)", (() => { const c = bind({ live: { ...liveMatch, source_refreshed_at: "2026-09-08T00:00:00Z" } }); return c.state === OLI_PUBLICATION_STATE.STALE && c.reason === "live-refresh-differs"; })());
ok("BINDING: live MISSING (candidate never promoted) -> STALE live-unpromoted", (() => { const c = bind({ live: null, hydratedLivePayload: null }); return c.state === OLI_PUBLICATION_STATE.STALE && c.reason === "live-unpromoted"; })());
ok("BINDING: live payload DIFFERS from the shadow candidate -> STALE live-payload-differs", (() => { const c = bind({ hydratedLivePayload: { rows: [{ d: 2 }] } }); return c.state === OLI_PUBLICATION_STATE.STALE && c.reason === "live-payload-differs"; })());
ok("BINDING: live identity mismatch (wrong params_hash) -> STALE live-identity-mismatch", (() => { const c = bind({ live: { ...liveMatch, params_hash: "WRONG" } }); return c.state === OLI_PUBLICATION_STATE.STALE && c.reason === "live-identity-mismatch"; })());
ok("BINDING: job NOT promotable -> STALE job-not-promotable (no valid candidate)", (() => { const c = bind({ job: { ...goodJob, validated: false } }); return c.state === OLI_PUBLICATION_STATE.STALE && c.reason === "job-not-promotable"; })());
ok("BINDING: durable OLI advanced past the job (depends_on missing a current hash) -> STALE oli-revision-changed", (() => { const c = bind({ job: { ...goodJob, dependsOn: ["h-a", "catalog"] } }); return c.state === OLI_PUBLICATION_STATE.STALE && c.reason === "oli-revision-changed"; })());
ok("BINDING: shadow MISSING -> STALE shadow-missing", (() => { const c = bind({ shadow: null, hydratedShadowPayload: null }); return c.state === OLI_PUBLICATION_STATE.STALE && c.reason === "shadow-missing"; })());
ok("BINDING: shadow hash != job hash -> STALE shadow-hash-mismatch", (() => { const c = bind({ shadow: { ...shadow, params_hash: "OTHER" } }); return c.state === OLI_PUBLICATION_STATE.STALE && c.reason === "shadow-hash-mismatch"; })());
ok("BINDING: ineligible revision -> DEFERRED_PROVENANCE", (() => { const c = bind({ revision: missing }); return c.state === OLI_PUBLICATION_STATE.DEFERRED_PROVENANCE; })());
ok("stableJson is key-order-stable", stableJson({ b: 1, a: [3, { y: 2, x: 1 }] }) === stableJson({ a: [3, { x: 1, y: 2 }], b: 1 }));

writeSync(1, `\noli-publication-revision: ${passed} assertions passed\n`);
