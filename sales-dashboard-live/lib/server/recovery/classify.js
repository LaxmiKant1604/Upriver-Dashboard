// Publication recovery worker -- PURE classification (v2, WP11) of what a reconciler / route CLI reported per
// (target, unit, report) -- saved-data-reconciler.js PUBLICATION_STATE / RECONCILE_STATUS as carried by the --emit-targets
// TARGETS line (v1 from the four legacy CLIs, lifted by normalizeTargets; v2 from the route CLI) -- into the worker's
// durable classes, outcomes and the owner HAND-OFF classes. A target is VERIFIED only when EVERY unit x report is
// PUBLICATION_NOT_REQUIRED from the exact publication binding (content identity + lineage + live read-back + the served
// row); a green exit, a READBACK_VERIFIED from the publishing run, a shadow or a job row is never sufficient.
//
// v2 RULES
//   * jobVerdict takes the WORST unit: zero-export / integrity > failed > stale > published-unverified >
//     preempted / capacity / contention / dependency / missing-evidence > superseded > not-applicable > current -- for the
//     FINAL outcome only: verdict.anyStale / staleUnits tell the worker to run the live pass whenever ANY unit is STALE
//     (a worse unit elsewhere in the target never blocks the repair of its stale units; the live CLI publishes only the
//     stale units).
//   * EVERY typed reason the routes emit maps to its stated class (REASON_RULES; SUBSTRING match, because releases prefix
//     'derive-not-ready:' / 'bundle-' / 'evidence-read-failed:'); NEWER_LIVE / newer-live -> superseded ONLY on a
//     DEFERRED_* state (a FAILED_* 'shadow-newer-live:content-differs' is an integrity failure, a deferred
//     'shadow-newer-live:<code>' a retryable read failure; the paid-publish stamp inversion is superseded + ALERT).
//   * ROUTE-CLI reasons (ctx.routeKind !== 'legacy-cli') are checked against REASON_RULES + the EXPLICIT
//     ROUTE_REASON_VOCABULARY only (built from the emitters; a static completeness suite scans them). The legacy
//     whitelist (LEGACY_REASON_CODES / LEGACY_PROVENANCE_RE) applies ONLY to the four legacy-cli routes (oli, ads, fba,
//     listings -- the worker passes routeKind), whose verdicts are unchanged.
//   * An UNKNOWN reason (or state) classifies FAIL-CLOSED as a typed deferral + alert 'unmapped-reason:<code>' -- never
//     current, never published.
//   * ROUTE-ONLY ordering fixes (WP11 verifier F3 / F4 / F7; the legacy verdicts are unchanged): a TYPED reason whose
//     LEADING code ends '-threw' is classified by that code alone, BEFORE any substring rule can read its message tail
//     (bounded transport retry + alert 'route-step-threw'; the rules naming the code itself still apply to the head; the
//     contract-thrown tails CONTRACT_THROWN_TAIL_CODES keep theirs -- the fba-plan fence stays route-not-activated, the
//     fba-plan derive integrity error stays integrity); the race-prone FAILED_* codes (RACE_TRANSIENT_CODES) are a
//     bounded transport retry + alert 'race-transient', never integrity.
//   * SERVED PROOF: a PUBLICATION_NOT_REQUIRED unit of a ROUTE CLI (or of an UNSPECIFIED route kind -- strict default)
//     counts current only with its served read-back (the unit's served row carries the unit's own h / sra); without it
//     the unit is a typed 'current-unserved' deferral. A legacy (v1, routeKind 'legacy-cli' explicitly) unit carries no
//     served fields: its class stays current (the durable verification the worker's tier-1 served-row check is anchored
//     to) and verdict.servedConfirmed is the worker's tier-1 confirmation (ctx.servedConfirmed === true) -- the owner
//     hand-off (handoffClass) is 'deferred' until that proof exists.
//   * classifyRun: a whole-run failure is RUN_FAILED only when the TARGETS line has NO targets; a 'failed' outcome WITH
//     per-target entries is classified per target (the ffb035b masking fix). run.zeroExport.blocked > 0 (the ZEROEXPORT
//     guard line) or any reported DataDoe create / token -> ZERO_EXPORT_VIOLATION; a V8 heap OOM / a heap cap below the
//     route's minimum -> capacity-exceeded; a runner argv refusal (runRoute argsError) -> config alert, except the
//     fba-plan UTC-midnight roll -> evidence-advanced; a route CLI STOP ROUTE_TARGET_OUT_OF_SCOPE (the directory-cache
//     race) -> a dependency deferral (no attempt) + alert; every other STOP -> run-failed + alert.
//   * Owner HAND-OFF classes: repaired | already-current | deferred | missing-source | failed | not-applicable.
// Pure; no I/O; 7-bit ASCII, LF.

import { normalizeTargets, TARGETS_UNITS_EMPTY } from "../sync/reconcile-targets-output.js";

export const STATES = Object.freeze({
  CURRENT: "PUBLICATION_NOT_REQUIRED",
  STALE: "STALE",
  PROVENANCE: "DEFERRED_PROVENANCE",
  DEPENDENCY: "DEFERRED_DEPENDENCY",
  PUBLISHED: "PUBLISHED_LIVE",
  READBACK_VERIFIED: "READBACK_VERIFIED",
  FAILED_DERIVE: "FAILED_DERIVE",
  FAILED_PUBLISH: "FAILED_PUBLISH",
  FAILED_READBACK: "FAILED_READBACK",
});

// Worker classes (stored in jobs.last_class / state.last_class and surfaced on the status panel).
export const CLASSES = Object.freeze({
  CURRENT: "current",                         // proven current by the exact binding (+ the served row)
  CURRENT_UNSERVED: "current-unserved",       // a route CLI's binding says current but the served read-back is unproven
  STALE: "stale",                             // saved evidence not yet reflected in the live report
  PUBLISHED_UNVERIFIED: "published-unverified", // the publishing run reported a publish; only a verify pass proves it
  MISSING_EVIDENCE: "missing-evidence",       // upstream saved evidence absent/ineligible -> reported, NEVER fetched
  DEPENDENCY: "dependency-deferral",          // legitimately not publishable yet (provisional / upstream report / race)
  CONTENTION: "contention",                   // global lease / controls held by another publisher -> retry later, no attempt
  NOT_ATTEMPTED: "not-attempted",             // the reconciler reserved its deadline for cleanup and never tried it
  EVIDENCE_ADVANCED: "evidence-advanced",     // the evidence / lineage moved under the run -> re-armed (re-evaluate soon)
  SERVED_ROW_PREEMPTED: "served-row-preempted", // a foreign / exact-today row holds the served slot -> deferred + alert
  CAPACITY_EXCEEDED: "capacity-exceeded",     // derive heap / deadline capacity (or a child OOM) -> long deferral + alert
  CONFIG_ALERT: "config-alert",               // the worker's own invocation is wrong (e.g. --as-of != UTC D-1) -> alert
  AWAIT_TIMEOUT: "await-timeout",             // an awaited route stayed open past PRW_AWAIT_MAX_MINUTES -> proceed + alert
  NOT_APPLICABLE: "not-applicable",           // nothing to publish for this evidence (a brand that is not sold)
  ROUTE_NOT_ACTIVATED: "route-not-activated", // the route's owner activation attestation is absent (config) -> deferred
  RUN_FAILED: "run-failed",                   // the whole run failed before any per-target result
  TIMEOUT: "timeout",                         // deadline / child hard timeout -> retry with backoff
  TRANSPORT: "transport",                     // transient I/O / process failure -> retry with backoff
  READBACK_MISMATCH: "readback-mismatch",     // publish reported ok but the binding still disagrees -> bounded retry
  SUPERSEDED_NEWER_LIVE: "superseded-newer-live", // a newer live / served row wins -> superseded for this evidence
  TERMINAL_CYCLE: "terminal-cycle-stuck",     // the revision's dedicated cycle is terminal -> cannot converge for it
  INTEGRITY: "permanent-integrity",           // malformed / conflicting evidence or a code defect -> dead-letter + alert
  ZERO_EXPORT_VIOLATION: "zero-export-violation", // a DataDoe create / token or a blocked DataDoe request -> dead + trip
  UNKNOWN: "unclassified",                    // an unmapped reason / state / malformed output -> typed deferral + alert
});

export const HANDOFF_CLASSES = Object.freeze({
  REPAIRED: "repaired", ALREADY_CURRENT: "already-current", DEFERRED: "deferred", MISSING_SOURCE: "missing-source", FAILED: "failed", NOT_APPLICABLE: "not-applicable",
});

// WORST-FIRST severity (jobVerdict picks the highest). Tiers: zero-export/integrity > failed > stale > deferrals > current.
const RANK = Object.freeze({
  [CLASSES.ZERO_EXPORT_VIOLATION]: 100, [CLASSES.INTEGRITY]: 95, [CLASSES.CONFIG_ALERT]: 92,
  [CLASSES.TERMINAL_CYCLE]: 90, [CLASSES.READBACK_MISMATCH]: 88, [CLASSES.RUN_FAILED]: 86, [CLASSES.TIMEOUT]: 85, [CLASSES.TRANSPORT]: 84, [CLASSES.UNKNOWN]: 83,
  [CLASSES.STALE]: 80, [CLASSES.PUBLISHED_UNVERIFIED]: 70,
  [CLASSES.SERVED_ROW_PREEMPTED]: 60, [CLASSES.CAPACITY_EXCEEDED]: 58, [CLASSES.ROUTE_NOT_ACTIVATED]: 57, [CLASSES.CONTENTION]: 56, [CLASSES.NOT_ATTEMPTED]: 55,
  [CLASSES.EVIDENCE_ADVANCED]: 54, [CLASSES.AWAIT_TIMEOUT]: 53, [CLASSES.DEPENDENCY]: 52, [CLASSES.CURRENT_UNSERVED]: 51, [CLASSES.MISSING_EVIDENCE]: 50,
  [CLASSES.SUPERSEDED_NEWER_LIVE]: 40, [CLASSES.NOT_APPLICABLE]: 30, [CLASSES.CURRENT]: 10,
});
export const classRank = (cls) => (Object.prototype.hasOwnProperty.call(RANK, cls) ? RANK[cls] : RANK[CLASSES.UNKNOWN]);

const S = (v) => (v == null ? "" : String(v));
const FAILED_STATES = new Set([STATES.FAILED_DERIVE, STATES.FAILED_PUBLISH, STATES.FAILED_READBACK]);
const DEFERRED_STATES = new Set([STATES.PROVENANCE, STATES.DEPENDENCY]);
const has = (r, ...subs) => subs.some((x) => r.includes(x));
/** The route kind whose reasons the legacy whitelist covers (routes.js LEGACY_ROUTE_IDS: oli, ads, fba, listings). */
export const LEGACY_ROUTE_KIND = "legacy-cli";
const isLegacy = (ctx) => !!ctx && ctx.routeKind === LEGACY_ROUTE_KIND;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// The UTC calendar day after a worker epoch 'YYYY-MM-DD' (the worker's OWN as-of text -- never a Postgres date).
const utcDayAfter = (d) => { const t = Date.parse(S(d) + "T00:00:00Z"); return Number.isFinite(t) ? new Date(t + 86400000).toISOString().slice(0, 10) : ""; };

// Reasons a PUBLICATION_NOT_REQUIRED unit may carry (the binding's null, the two-phase already-current proof, the
// portfolio's unchanged unit manifest, fba-plan's content-equivalence proof). Anything else on a current state is
// UNMAPPED -> typed deferral + alert (never counted current).
const CURRENT_REASONS = Object.freeze(["already-current", "unit-manifest-unchanged", "content-equivalent"]);
const SOURCE_STALE_MANUAL = "source-stale-manual";
// fba-plan fill-only (plan-addendum orchestratorDesignDecisions WP7): 'evidence-instant-not-advanced' on fba-plan is
// the ACCEPTED 'awaiting the next paid FBA fetch' state -- the reason is kept VERBATIM, this note is attached, no alert.
export const FBA_PLAN_EVIDENCE_INSTANT_NOTE = "awaiting-next-fba-fetch";
// The routes' activation codes: fba-plan (lib/server/sync/routes/fba-plan.release.js FBA_PLAN_ROUTE_FENCE_NOT_ATTESTED)
// and sku-movement (sku-movement.release.js SKU_MOVEMENT_ROUTE_NOT_ACTIVATED: every LIVE write deferred while
// SKU_MOVEMENT_SERVE_TOKEN_ATTESTED is not exactly 'true' -- 'derive-not-ready:<code>' from the derive gate, bare from its
// publishGuard on the resume path).
const FBA_PLAN_FENCE_NOT_ATTESTED = "fba-plan-route-fence-not-attested";
const SKU_MOVEMENT_ROUTE_NOT_ACTIVATED = "sku-movement-serve-not-attested:route-not-activated";
// The generic NEWER_LIVE vocabulary (route-publication-release newerLive / publishGuardResult; the fill-only
// 'superseded-newer-live:*'; returns-v3 'served-newer-to'; the stampPolicy 'evidence' NEWER_LIVE codes).
const NEWER_LIVE_RE = /newer-live|NEWER_LIVE/i;
const isNewerLiveReason = (r) => NEWER_LIVE_RE.test(r) || has(r, "evidence-not-newer-than-live", "evidence-not-newer-than-served", "served-newer-to");
// The inventory / AWD guards that could not read (or order) what they protect (fba-plan-dependency-bundle.js
// fbaPlanLiveGuard / awd regression guard; bare, 'bundle-' prefixed or from publishGuard): ALERT + retry.
const GUARD_UNREADABLE_CODES = Object.freeze([
  "inventory-guard:served-unreadable", "inventory-guard:live-unreadable", "inventory-guard:paid-lineage-unreadable", "inventory-guard:paid-cycle-unreadable",
  "inventory-guard:fetch-unordered", "inventory-guard:awd-fetch-unordered", "inventory-guard:sales-asof-unordered", "inventory-guard:sales-asof-missing",
  "awd-regression-guard:served-unreadable",
]);
// Publisher GATE refusals (report-publisher.js preflight / publish dispositions): the account / report is not approved
// or enabled for publication -- configuration, not data (a retry cannot help until the owner changes the gate).
const PUBLISHER_GATE_DISPOSITIONS = Object.freeze(["unknown-report", "code-locked", "report-disabled", "account-disabled", "publish-not-approved"]);
const GATE_REFUSED_RE = new RegExp("^(?:preflight|publish)-(?:" + PUBLISHER_GATE_DISPOSITIONS.join("|") + ")$");
// Route code-defect markers (practically unreachable typed guards of the route runtimes -- a deterministic defect for the
// SAME evidence, never a transient): integrity + alert, never a silent 900 s deferral loop.
const ROUTE_CODE_DEFECT_CODES = Object.freeze([
  "unbound-read:", "bundle-malformed", "unit-malformed", "bad-unit", "bundle-missing", "bundle-empty", "evidence-not-strict", "evidence-not-ready",
  "invalid-asof", "read-missing:", "brand-view-empty", "portfolio-empty", "portfolio-derive-threw", "unit-target-invalid", "lineage-id-missing",
  "publish-guard-malformed", "publish-guard-deferred",
]);
// RACE-PRONE route FAILED_* codes (WP11 verifier F3): a concurrent twin run / a paid job / a control-plane race produces
// them (the preflight saw a non-successful disposition, the reconcile lease or the claim went terminal under us, the
// cycle finalize found work another writer opened) -- the SAME evidence can succeed on a later pass, so they are a
// BOUNDED transport retry + alert, never the catch-all integrity dead-letter. Exact codes (wrapper-stripped).
export const RACE_TRANSIENT_CODES = Object.freeze(["preflight-not-successful", "reconcile-lease-lost", "claim-terminal", "finalize-open-work"]);
// The route reasons whose 'derive-threw:' TAIL is a typed code BY CONTRACT (a route runtime's derive throws an Error whose
// message LEADS with that code; route-publication-release.js reports 'derive-threw:' + message): fba-plan.release.js
// throws `${FBA_PLAN_ROUTE_FENCE_NOT_ATTESTED}: ...` while FBA_PLAN_ROUTE_FENCE_ATTESTED is not 'true' (-> route-not-
// activated) and 'fba-plan-derive-invalid:<errorCode>' for a genuine derive integrity error (-> integrity, alert
// 'derive-invalid'). Those keep their tail classification; every other '-threw' tail is a message. Pinned against the
// runtimes' throw sites by scripts/recovery-classify-vocabulary.test.js V5.
export const CONTRACT_THROWN_TAIL_CODES = Object.freeze([FBA_PLAN_FENCE_NOT_ATTESTED, "fba-plan-derive-invalid"]);
const isContractThrownTail = (r) => wrapperForms(r).some((c) => CONTRACT_THROWN_TAIL_CODES.some((code) => c === "derive-threw:" + code || c.startsWith("derive-threw:" + code + ":")));
/**
 * The LEADING code of a route reason when it ends '-threw' (under at most ONE release wrapper): { head, code } where head
 * is the reason up to and including that code (wrapper kept, the ':<message>' tail dropped), else null. The tail of a
 * '*-threw:' reason is a thrown error's MESSAGE (sanitizeReasonCode keeps its first token), never a typed code.
 */
export function leadingThrewHead(reason) {
  const r = S(reason);
  for (const c of wrapperForms(r)) {
    const i = c.indexOf(":");
    const code = i < 0 ? c : c.slice(0, i);
    if (/^[a-z][a-z0-9-]*-threw$/.test(code)) return { head: r.slice(0, r.length - c.length) + code, code };
  }
  return null;
}
// WP11 verifier F4 + F7: a TYPED route reason whose leading code ends '-threw' is classified by that leading code alone
// -- the REASON_RULES that name the code itself (publish-guard-threw -> its own alert; portfolio-derive-threw -> the
// route code-defect integrity) are applied to the HEAD only, and otherwise it is a BOUNDED transport retry + alert
// 'route-step-threw' (e.g. 'lineage-read-threw:brand-not-sold' is NOT not-applicable, 'bundle-resolve-threw:superseded-
// newer-live' is NOT superseded, DEFERRED_PROVENANCE 'revision-threw' is NOT missing-evidence). An UNTYPED '-threw' code
// stays unmapped (fail closed); the legacy families keep their ffb035b verdicts (V2 of the vocabulary suite).
const THREW_ALERT = "route-step-threw";
function threwVerdict(r, st, ctx) {
  const h = leadingThrewHead(r);
  const head = h ? h.head : r;
  for (const rule of REASON_RULES) {
    if (rule.id === "leading-threw" || !rule.test(head, st, ctx)) continue;
    return { cls: typeof rule.cls === "function" ? rule.cls(head, st, ctx) : rule.cls, alert: (typeof rule.alert === "function" ? rule.alert(head, st, ctx) : rule.alert) || THREW_ALERT };
  }
  return { cls: CLASSES.TRANSPORT, alert: THREW_ALERT };
}

/**
 * The HANDOFF-typed REASON RULES (first match wins; SUBSTRING match). Each rule:
 * { id, test(r, state, ctx) -> bool, cls | cls(r, state, ctx), alert: null | string | fn, reason?: fn, note?: fn }.
 * Rules whose codes a legacy family could also emit keep their legacy verdicts (the scoped ones test ctx.routeKind).
 */
export const REASON_RULES = Object.freeze([
  // WRITER FENCE (WP14 e2e finding): a unit whose write was refused by the DB writer fence ('REPORT_WRITER_FENCED:<key>',
  // SQLSTATE RWF01 -- possibly inside a '-threw' tail) came from a writer that should be FENCED: the live row stayed LKG,
  // but from a fenced route / reconciler this is a defect or a fence / deploy mismatch -> INTEGRITY + alert
  // 'writer-fenced' (never unclassified, never a retry loop against the fence). Checked before every other rule.
  { id: "writer-fenced", test: (r) => /REPORT_WRITER_FENCED/.test(r), cls: CLASSES.INTEGRITY, alert: "writer-fenced" },
  // (F4/F7) a typed route reason whose LEADING code ends '-threw' is classified by that code before any substring
  // rule can read its message tail (threwVerdict above; CONTRACT_THROWN_TAIL_CODES are the documented exceptions).
  { id: "leading-threw", test: (r, st, ctx) => !isLegacy(ctx) && leadingThrewHead(r) != null && !isContractThrownTail(r) && routeVocabularyMatch(r), cls: (r, st, ctx) => threwVerdict(r, st, ctx).cls, alert: (r, st, ctx) => threwVerdict(r, st, ctx).alert },
  // (F3) race-prone route FAILED_* codes: bounded transport retry + alert (never the catch-all integrity dead-letter).
  { id: "race-transient", test: (r, st, ctx) => !isLegacy(ctx) && FAILED_STATES.has(st) && RACE_TRANSIENT_CODES.some((c) => routeCodeIs(r, c)), cls: CLASSES.TRANSPORT, alert: "race-transient" },
  // (P1) the refused-shadow codes (route-publication-release.js prepare step 8): a newer shadow at the SAME
  // content-addressed params hash whose CONTENT DIFFERS is a hard integrity failure (FAILED_DERIVE) -- never superseded.
  { id: "shadow-content-differs", test: (r, st, ctx) => !isLegacy(ctx) && has(r, "shadow-newer-live:content-differs"), cls: CLASSES.INTEGRITY, alert: "shadow-content-differs" },
  // (P1) 'shadow-newer-live:<code>' (a DEFERRED_DEPENDENCY: the newer same-hash shadow could not be read / validated --
  // validShadowAt: shadow-missing (a read that returned nothing / threw), shadow-payload-unavailable (hydration), or a
  // shadow failing validation). TRANSPORT, justified: the refused CAS proves a newer shadow at the SAME
  // content-addressed hash, i.e. the evidence did NOT move (EVIDENCE_ADVANCED would be false and would re-arm without
  // an attempt bound); the failing step is a READ of that shadow (transient in practice), so it retries with exponential
  // backoff and -- only if it persists (a structurally foreign / corrupt shadow at our hash) -- escalates to a
  // dead-letter after maxAttempts. Never the terminal, alert-less superseded class: the route job was left LATEST, so a
  // superseded dead job would strand the target's lineage silently. Alerted on every occurrence.
  { id: "shadow-newer-live-unreadable", test: (r, st, ctx) => !isLegacy(ctx) && DEFERRED_STATES.has(st) && /(?:^|:)shadow-newer-live:/.test(r), cls: CLASSES.TRANSPORT, alert: "shadow-newer-live-unreadable" },
  // (P1) the fba-plan STAMP INVERSION (bare, 'bundle-' prefixed or a publishGuard NEWER_LIVE): paid content is not being
  // served -- superseded for this evidence but an ALERT (never benign). MUST precede the generic newer-live rule.
  { id: "paid-refused-by-route-stamp", test: (r, st, ctx) => !isLegacy(ctx) && DEFERRED_STATES.has(st) && has(r, "paid-publish-refused-by-route-stamp"), cls: CLASSES.SUPERSEDED_NEWER_LIVE, alert: "paid-publish-refused-by-route-stamp" },
  // superseded: a newer live / served row (or a paid-owned / paid-pending row) wins for this evidence -- ONLY as a
  // deferral (the release's NEWER_LIVE status -> DEFERRED_DEPENDENCY). A legacy family keeps its ffb035b mapping
  // (any state), unchanged.
  { id: "newer-live", test: (r, st, ctx) => isNewerLiveReason(r) && (DEFERRED_STATES.has(st) || isLegacy(ctx)), cls: CLASSES.SUPERSEDED_NEWER_LIVE, alert: null },
  // evidence instant (stampPolicy 'evidence'): the reason is kept VERBATIM; fba-plan = the accepted fill-only state
  // (note 'awaiting-next-fba-fetch', NO alert -- a recorded deviation, plan-addendum orchestratorDesignDecisions WP7);
  // every other route alerts.
  { id: "evidence-instant", test: (r) => has(r, "evidence-instant-not-advanced"), cls: CLASSES.DEPENDENCY, alert: (r, s, ctx) => (ctx.routeId === "fba-plan" ? null : "evidence-instant-not-advanced"), note: (r, s, ctx) => (ctx.routeId === "fba-plan" ? FBA_PLAN_EVIDENCE_INSTANT_NOTE : null) },
  // the returns / settlement history paged read repeated a primary-key tuple (returns-publish.js strict gather): the
  // read raced a concurrent write (or the reader lost its full-PK order) -- re-armed like any evidence race, but ALERTED.
  { id: "history-duplicate-key", test: (r, st, ctx) => !isLegacy(ctx) && has(r, "evidence-inconsistent:returns-duplicate", "evidence-inconsistent:settlement-duplicate"), cls: CLASSES.EVIDENCE_ADVANCED, alert: "history-duplicate-key" },
  // integrity (alert): '*-integrity' pointers (arrive as DEFERRED_PROVENANCE), publish-guard code defects, an
  // unrepresentable portfolio scope id, a fba-plan derive integrity error.
  { id: "integrity", test: (r) => /-integrity(:|$)/.test(r) || has(r, "publish-guard:guard-missing", "publish-guard:guard-mismatch", "portfolio-scope-id-too-long", "fba-plan-derive-invalid"), cls: CLASSES.INTEGRITY, alert: (r) => (has(r, "publish-guard:") ? "publish-guard-defect" : has(r, "portfolio-scope-id-too-long") ? "portfolio-scope-id-too-long" : has(r, "fba-plan-derive-invalid") ? "derive-invalid" : "integrity") },
  // (P2b) a route DERIVE that refused its own payload identity ('derive-not-ready:<x>-mismatch', e.g. returns-v3
  // payload-account / payload-asof / payload-latest-date-mismatch) is a code / data integrity failure, never a retry loop.
  { id: "derive-mismatch", test: (r, st, ctx) => !isLegacy(ctx) && /^derive-not-ready:[A-Za-z0-9._-]*-mismatch(?::|$)/.test(r), cls: CLASSES.INTEGRITY, alert: "derive-mismatch" },
  // route code-defect markers (see ROUTE_CODE_DEFECT_CODES).
  { id: "route-code-defect", test: (r, st, ctx) => !isLegacy(ctx) && DEFERRED_STATES.has(st) && ROUTE_CODE_DEFECT_CODES.some((c) => routeCodeIs(r, c)), cls: CLASSES.INTEGRITY, alert: "route-code-defect" },
  { id: "capacity", test: (r) => has(r, "capacity-exceeded"), cls: CLASSES.CAPACITY_EXCEEDED, alert: "capacity-exceeded" },
  // served-row preempted; sku-movement 'serve-rederives' before the WP10 serve attestation is the EXPECTED pre-WP10 state.
  { id: "served-preempted", test: (r) => has(r, "served-row-preempted"), cls: CLASSES.SERVED_ROW_PREEMPTED, alert: (r, s, ctx) => (has(r, "serve-rederives") && ctx.skuMovementServeAttested !== true ? "serve-not-attested" : "served-row-preempted") },
  // fba-plan --as-of (bare / 'bundle-'): the runner only ever spawns an fba-plan child at --as-of == fbaInventoryAsOf(spawn
  // instant), so the D-1 advancing by AT MOST one day since the args were built (a UTC-midnight roll mid-run -- the
  // expected as-of is measured at the verdict, possibly after the child) is a re-armed retry; any other --as-of (or no
  // run context) is a config ALERT.
  { id: "epoch-not-d1", test: (r) => has(r, "epoch-not-current-d1"), cls: (r, s, ctx) => (midnightRoll(ctx) ? CLASSES.EVIDENCE_ADVANCED : CLASSES.CONFIG_ALERT), alert: (r, s, ctx) => (midnightRoll(ctx) ? null : "as-of-not-utc-d1") },
  // guards that could not read what they protect: alert + retry.
  { id: "guard-unreadable", test: (r) => GUARD_UNREADABLE_CODES.some((c) => has(r, c)), cls: CLASSES.TRANSPORT, alert: "guard-unreadable" },
  { id: "paid-raced", test: (r) => has(r, "paid-job-raced-insert"), cls: CLASSES.TRANSPORT, alert: "paid-job-raced-insert" },
  { id: "publish-guard-threw", test: (r) => has(r, "publish-guard-threw"), cls: CLASSES.TRANSPORT, alert: "publish-guard-threw" },
  { id: "paid-stale-in-flight", test: (r) => has(r, "paid-job-stale-in-flight"), cls: CLASSES.DEPENDENCY, alert: "paid-job-stale-in-flight" },
  { id: "paid-in-flight", test: (r) => has(r, "paid-job-in-flight"), cls: CLASSES.DEPENDENCY, alert: null },
  // an OPEN paid fba cycle: the paid path's publication in progress (retryable, NO alert); idle on the current epoch
  // ('stale-open') = a stuck paid cycle (dependency + ALERT).
  { id: "paid-cycle-stale-open", test: (r) => has(r, "paid-cycle-stale-open"), cls: CLASSES.DEPENDENCY, alert: "paid-cycle-stale-open" },
  { id: "paid-cycle-open", test: (r) => has(r, "paid-cycle-open"), cls: CLASSES.DEPENDENCY, alert: null },
  // re-armed: the evidence / lineage / as-of moved under the run (transient races; re-evaluated soon, no attempt) --
  // incl. every '*-advanced' input check (Brand View fingerprint inputs, the dependency fingerprint, the sku-movement
  // brand list) and a portfolio unit whose member / label identity changed since the scan.
  { id: "advanced", test: (r, st, ctx) => has(r, "evidence-advanced", "membership-evidence-advanced", "ads-rows-window-mismatch", "publish-guard:lineage-advanced", "lineage-advanced", "revision-advanced", "manifest-advanced", "asof-rolled", "ads-revision-changed-since-scan", "evidence-inconsistent", "already-current-lost", "source-revision-changed") || (!isLegacy(ctx) && has(r, "fingerprint-inputs-advanced", "dep-fingerprint-advanced", "brand-list-advanced", "unit-identity-changed")), cls: CLASSES.EVIDENCE_ADVANCED, alert: null },
  // route not activated: an unattested owner activation gate (fba-plan FBA_PLAN_ROUTE_FENCE_ATTESTED: 'derive-threw:
  // fba-plan-route-fence-not-attested:' FAILED_DERIVE, or bare from publishGuard; sku-movement
  // SKU_MOVEMENT_SERVE_TOKEN_ATTESTED: 'derive-not-ready:sku-movement-serve-not-attested:route-not-activated' or bare from
  // publishGuard, both DEFERRED_DEPENDENCY) -- config; no attempt burned; hand-off DEFERRED (applicable, just not
  // activated), re-checked, never terminal.
  { id: "route-not-activated", test: (r) => has(r, FBA_PLAN_FENCE_NOT_ATTESTED, SKU_MOVEMENT_ROUTE_NOT_ACTIVATED, "route-not-activated"), cls: CLASSES.ROUTE_NOT_ACTIVATED, alert: "route-not-activated" },
  // not applicable: a brand with no sales (kept out of live passes until its token changes).
  { id: "brand-not-sold", test: (r) => has(r, "brand-not-sold"), cls: CLASSES.NOT_APPLICABLE, alert: null },
  // not applicable (source-absent): brand-view's verified EMPTY brand directory -- the target's unit expansion is empty
  // because the EXACT validated live brand-view-brands row (inline, payload.accountId matching) lists zero brands
  // (brand-view.route.js); brand-view publishes one unit per directory brand, so there is nothing to publish for this
  // evidence. The directory's own currency is the brand-view-brands route's job, and a directory change re-tokens
  // brand-view (a new job). units-empty on any OTHER route stays a dependency deferral + alert (below).
  { id: "units-empty-brand-view", test: (r, st, ctx) => r === TARGETS_UNITS_EMPTY && ctx.routeId === "brand-view", cls: CLASSES.NOT_APPLICABLE, alert: null },
  // the fba-plan route's served row (params / payload) could not be captured: a read problem -> retry.
  { id: "served-row-unreadable", test: (r, st, ctx) => !isLegacy(ctx) && has(r, "served-row-unreadable"), cls: CLASSES.TRANSPORT, alert: null },
  // a portfolio target outside the scan region (brand-view-portfolio.release.js): the worker handed the CLI a target the
  // bucket does not own -- the invocation is wrong (CONFIG_ALERT), never evidence.
  { id: "target-not-this-region", test: (r, st, ctx) => !isLegacy(ctx) && has(r, "target-not-this-region"), cls: CLASSES.CONFIG_ALERT, alert: "target-not-this-region" },
  // publisher gate refusals (preflight / publish '<gate disposition>'): configuration (approval / report switch).
  { id: "publisher-gate-refused", test: (r, st, ctx) => !isLegacy(ctx) && GATE_REFUSED_RE.test(r), cls: CLASSES.CONFIG_ALERT, alert: "publisher-gate-refused" },
  // the control apply's commit state is unknown (the cleanup must reconcile it): retry + alert.
  { id: "control-commit-unknown", test: (r, st, ctx) => !isLegacy(ctx) && r === "control-apply-commit-unknown", cls: CLASSES.TRANSPORT, alert: "control-commit-unknown" },
  // missing saved evidence (typed; LKG kept; never an export). Some are alert-worthy (can be permanent / data problems).
  { id: "missing-alert", test: (r) => has(r, "storage-missing", "brand-list-invalid", "brand-target-unrepresentable", "member-directory-ambiguous", "pan-eu-ambiguous", "brand-directory-invalid"), cls: CLASSES.MISSING_EVIDENCE, alert: (r) => (has(r, "storage-missing") ? "storage-missing" : "evidence-ambiguous-or-invalid") },
  // a route's saved evidence is PRESENT but defective (fba-plan rows / AWD rows / a dangling storage object / a raw-seller
  // or sales-as-of the scope resolver disagrees with; a portfolio directory id / member outside the region universe):
  // typed missing-evidence (LKG kept, re-evaluated when the evidence is re-persisted) + ALERT. Route-only: the legacy fba
  // family keeps its own verdicts for the codes it shares (fba-rows-invalid, fba-payload-dangling).
  { id: "evidence-defect", test: (r, st, ctx) => !isLegacy(ctx) && has(r, "sales-asof-mismatch", "raw-seller-mismatch", "fba-rows-invalid", "fba-rows-cross-account", "awd-rows-invalid", "fba-payload-dangling", "awd-payload-dangling", "directory-id-invalid", "member-not-in-region-universe"), cls: CLASSES.MISSING_EVIDENCE, alert: "evidence-ambiguous-or-invalid" },
  { id: "missing", test: (r) => has(r, "returns-evidence-missing", "catalog-missing", "oli-coverage-short", "directory-country-missing", "directory-region-unassigned", "no-sales-snapshot", "brand-source-out-of-line", "membership-read-failed", "catalog-empty", "serve-token-underivable", "coverage-incomplete", "no-marketplace", "brand-directory-out-of-line", "ads-rows-evidence-missing", "brand-directory-evidence-missing", "brand-view-evidence-missing") || /(^|:)awd-regression-guard$/.test(r), cls: CLASSES.MISSING_EVIDENCE, alert: null },
  // dependency deferrals (retryable) incl. the alert-worthy ambiguous latest row and a builder failure (the page shows
  // the same error -- a product / data question, never "fixed" silently).
  { id: "latest-ambiguous", test: (r) => has(r, "latest-row-ambiguous"), cls: CLASSES.DEPENDENCY, alert: "latest-row-ambiguous" },
  { id: "build-failed", test: (r, st, ctx) => has(r, "portfolio-build-failed") || (!isLegacy(ctx) && has(r, "brand-view-build-failed", "directory-build-failed")), cls: CLASSES.DEPENDENCY, alert: (r) => (has(r, "portfolio-build-failed") ? "portfolio-build-failed" : has(r, "brand-view-build-failed") ? "brand-view-build-failed" : "directory-build-failed") },
  { id: "units-empty", test: (r) => r === TARGETS_UNITS_EMPTY, cls: CLASSES.DEPENDENCY, alert: "units-empty" },
  { id: "dependency", test: (r) => has(r, "member-setting-up", "brand-directory-unpublished", "brand-sales-candidate"), cls: CLASSES.DEPENDENCY, alert: null },
  // transient reads.
  { id: "transient-read", test: (r) => has(r, "hydrate-failed", "evidence-read-failed", "served-read-failed", "evidence-unreadable"), cls: CLASSES.TRANSPORT, alert: null },
  // route-only transient reads (a derive / fingerprint / brand-list / durable payload read that failed); the legacy fba
  // family keeps its own verdict for 'fba-payload-unreadable'.
  { id: "route-transient-read", test: (r, st, ctx) => !isLegacy(ctx) && has(r, "derive-not-ready:read-failed:", "fingerprint-read-failed", "brand-list-read-failed", "fba-payload-unreadable", "awd-payload-unreadable"), cls: CLASSES.TRANSPORT, alert: null },
]);

// A route reason IS one of the (wrapper-stripped) codes: exact, or a ':'-terminated prefix entry.
function routeCodeIs(r, code) {
  for (const c of wrapperForms(r)) if (code.endsWith(":") ? c.startsWith(code) : c === code) return true;
  return false;
}

/** True when a mid-run UTC-midnight roll explains an fba-plan 'epoch-not-current-d1' (see the epoch-not-d1 rule). */
function midnightRoll(ctx) {
  const a = S(ctx && ctx.argAsOf), e = S(ctx && ctx.expectedAsOf);
  return DATE_RE.test(a) && DATE_RE.test(e) && (a === e || utcDayAfter(a) === e);
}

// ---- the EXPLICIT ROUTE REASON VOCABULARY (P2b) -------------------------------------------------------------------
// Every typed reason code the route CLI's releases emit onto a TARGETS v2 unit (collected from route-publication-release.js,
// saved-data-reconciler.js, publication-binding.js, live-promoted-resolver.js, serve-selectors.js, the six
// lib/server/sync/routes/*.release.js runtimes and what they call: fba-plan-dependency-bundle.js, returns-publish.js,
// sku-movement-durable-rederive.js, report-materialization-brandview-composition.js, lib/server/recovery/routes/*.route.js
// revision helpers). An entry is an EXACT code, or a PREFIX ending in ':' whose tail is dynamic (a key, a status, an
// error-message code). A reason is matched after stripping ONE release wrapper ('bundle-' <resolveBundle / revision
// reason>, 'derive-not-ready:' <derive notReady reason>). A route reason that is neither matched by a REASON_RULE nor in
// this vocabulary is UNMAPPED (typed deferral + alert). scripts/recovery-classify-vocabulary.test.js scans the emitter
// files and fails on any code literal that is neither a vocabulary / rule code nor an explicitly listed non-reason literal.
export const ROUTE_REASON_WRAPPERS = Object.freeze(["bundle-", "derive-not-ready:"]);
export const ROUTE_REASON_VOCABULARY = Object.freeze(new Set([
  // saved-data-reconciler.js core (scan / classification / two-phase / controls)
  "not-eligible", "revision-missing", "revision-malformed", "revision-threw", "expand-units-threw", "units-invalid:", "target-asof-unresolved", "binding-threw:",
  "current-predicate-threw", "current-predicate-invalid", "served-check-threw", "served-check-invalid", "served-row-differs", "manifest-differs", "served-row-preempted:",
  "already-current", "prepare-threw", "prepare-result-malformed", "prepare-unconfirmed", "publish-threw", "publish-result-malformed", "deadline-cleanup-reserved",
  "deadline-in-flight", "deadline-account-in-flight", "deadline-termination-unconfirmed", "controls-open-threw", "controls-not-opened:", "control-apply-commit-unknown", "controls-close-unresolved",
  // publication-binding.js (STALE reasons of the exact binding)
  "job-not-promotable", "source-revision-changed", "no-live-contract", "no-report-derivation", "shadow-missing", "shadow-identity-report-key", "shadow-identity-account",
  "shadow-params-account", "shadow-version", "shadow-hash-mismatch", "shadow-refresh-blank", "shadow-payload-unavailable", "shadow-payload-validator-threw",
  "shadow-payload-invalid", "live-params-underivable", "live-contract-asof-field-invalid", "requested-asof-invalid", "candidate-asof-invalid", "candidate-asof-not-exact",
  "shadow-target-identity", "shadow-live-params-extra-invalid", "live-account-underivable", "live-account-mismatch", "live-unpromoted", "live-identity-mismatch",
  "live-readback:", "live-refresh-differs", "live-payload-unavailable", "live-payload-differs", "live-params-extra-differs",
  // route-publication-release.js prepare
  "deadline-aborted", "bad-args", "bad-revision", "lineage-read-threw:", "bundle-resolve-threw:", "revision-advanced-at-entry", "manifest-token-invalid", "guard-invalid",
  "resume-live-identity-mismatch", "identity-asof-threw:", "derive-threw:", "derive-malformed", "payload-malformed", "payload-invalid", "payload-too-large", "data-unavailable",
  "bundle-recheck-threw:", "revision-advanced-before-write", "manifest-advanced-before-write", "asof-rolled", "identity-params-threw:", "identity-params-invalid",
  "depFingerprint-invalid", "serveToken-invalid", "target-identity-mismatch", "live-identity-underivable", "semantic-identity:", "lineage-would-not-cover-revision",
  "evidence-instant-invalid", "evidence-instant-future", "evidence-instant-not-advanced", "evidence-not-newer-than-live", "evidence-not-newer-than-served",
  "lineage-id-missing", "lineage-advanced-before-write", "cycle-open-threw:", "cycle-read-threw:", "cycle-unresolved", "cycle-refresh-blank", "cycle-claim-threw:",
  "cycle-reclaim-read-threw:", "cycle-not-running:", "lineage-upsert-threw:", "claim-threw:", "already-complete-hash-mismatch", "claim-held", "claim-terminal",
  "claim-invalid-state", "claim-not-found", "claim-invalid-lease", "claim-claimed", "claim-reclaimed", "claim-malformed", "shadow-cas-threw:", "shadow-newer-live:",
  "shadow-conflict:", "reconcile-threw:", "reconcile-snapshot-absent", "reconcile-lease-lost", "reconcile-terminal", "reconcile-invalid-state", "reconcile-not-running",
  "reconcile-not-found", "reconcile-invalid-hash", "reconcile-invalid-lease", "reconcile-malformed", "finalize-threw:", "finalize-open-work", "finalize-not-found",
  "finalize-invalid-status", "finalize-malformed",
  // route-publication-release.js publish
  "prepared-mismatch", "evidence-advanced", "already-current-lost:", "lineage-advanced", "publisher-unavailable", "preflight-threw:", "preflight-lease-lost",
  ...PUBLISHER_GATE_DISPOSITIONS.map((d) => "preflight-" + d), "preflight-not-successful", "preflight-invalid-snapshot", "preflight-data-unavailable",
  "preflight-publish-failed", "preflight-identity-mismatch", "lease-lost-before-publish:", "publish-guard-threw:", "publish-guard-malformed", "publish-guard-deferred",
  "publish-threw:", "publish-lease-lost", "publish-newer-live", "publish-newer-live:", ...PUBLISHER_GATE_DISPOSITIONS.map((d) => "publish-" + d), "publish-publish-conflict",
  "publish-publish-failed", "publish-not-successful", "publish-invalid-snapshot", "publish-data-unavailable", "publish-identity-mismatch", "live-readback-failed:",
  "live-row-unreadable", "live-tokens-differ", "lineage-advanced-during-publish",
  // fba-plan (fba-plan.release.js + fba-plan-dependency-bundle.js)
  "evidence-missing", "epoch-not-current-d1", "directory-missing", "account-out-of-region", "pan-eu-ambiguous", "sales-asof-mismatch", "raw-seller-mismatch",
  "inventory-asof-invalid", "directory-incomplete", "object-path-builder-missing", "fba-pointer-integrity:", "fba-durable-missing", "fba-expected-hash-unresolved",
  "fba-snapshot-not-d1", "sales-asof-unresolved", "oli-coverage-short", "catalog-durable-missing", "catalog-pointer-integrity:", "awd-durable-missing", "awd-durable-stale",
  "awd-pointer-integrity:", "evidence-unreadable", "aborted", ...GUARD_UNREADABLE_CODES, "fba-payload-unreadable:", "fba-payload-dangling", "fba-rows-invalid:",
  "fba-rows-cross-account", "awd-payload-unreadable:", "awd-payload-dangling", "awd-rows-invalid:", "awd-regression-guard", "durable-context-threw:",
  "durable-oli-unavailable", "durable-catalog-unavailable", "evidence-instant-unresolved", "superseded-newer-live:served-newer-to", "superseded-newer-live:paid-owned",
  "superseded-newer-live:served-newer-inventory", "superseded-newer-live:served-newer-awd", "superseded-newer-live:paid-publish-pending:to",
  "superseded-newer-live:paid-publish-pending:inventory", "superseded-newer-live:paid-publish-pending:awd", "superseded-newer-live:paid-publish-refused-by-route-stamp",
  "paid-job-in-flight", "paid-job-stale-in-flight", "paid-cycle-open:", "paid-cycle-stale-open:", "served-read-failed", "served-missing", "served-out-of-line",
  "served-version-hidden", "served-row-unreadable", "served-older-to", "revision-advanced", "content-derive-failed", "derive-unavailable", "derive-blocked",
  "derive-unmapped", "derive-not-implemented", "content-differs", "content-equivalent", FBA_PLAN_FENCE_NOT_ATTESTED, "publish-guard:guard-missing",
  "publish-guard:guard-mismatch", "publish-guard:lineage-advanced", "paid-job-raced-insert",
  // returns-v3 (returns-v3.release.js, returns-v3.route.js, returns-publish.js)
  "returns-evidence-missing", "evidence-epoch-mismatch", "catalog-missing", "directory-country-missing", "bad-unit", "evidence-read-failed:", "served-newer-to",
  "evidence-not-ready", "evidence-not-strict", "invalid-asof", "evidence-inconsistent:", "payload-account-mismatch", "payload-asof-mismatch",
  "payload-latest-date-mismatch", SOURCE_STALE_MANUAL,
  // sku-movement (sku-movement.release.js, sku-movement.route.js, sku-movement-durable-rederive.js)
  "coverage-incomplete", "no-marketplace", "evidence-inconsistent", "brand-list-unavailable", "brand-list-read-failed", "brand-list-advanced", "brand-list-invalid",
  "brand-target-unrepresentable", "unit-target-invalid", "not-ready", "catalog-empty", "serve-token-underivable", "bundle-missing", SKU_MOVEMENT_ROUTE_NOT_ACTIVATED,
  // brand-view-brands / brand-view / brand-view-portfolio
  "latest-row-ambiguous:", "brand-directory-evidence-missing", "evidence-unreadable:", "read-failed:", "unbound-read:", "evidence-advanced:", "storage-missing:",
  "hydrate-failed:", "directory-build-failed:", "read-missing:", "brand-view-evidence-missing", "brand-directory-unpublished", "brand-directory-out-of-line",
  "brand-directory-invalid", "ads-rows-evidence-missing", "ads-rows-window-mismatch", TARGETS_UNITS_EMPTY, "unit-malformed", "brand-not-in-directory",
  "fingerprint-threw:", "fingerprint-read-failed:", "fingerprint-invalid", "fingerprint-inputs-advanced:", "bundle-malformed", "no-sales-snapshot", "brand-not-sold",
  "brand-view-build-failed", "brand-view-empty", "dep-fingerprint-advanced", "target-not-this-region", "directory-id-invalid", "region-directory-empty",
  "membership-read-failed", "membership-evidence-advanced", "portfolio-scope-id-too-long", "member-not-in-region-universe", "member-setting-up",
  "member-directory-ambiguous", "unit-identity-changed", "capacity-exceeded:", "portfolio-build-failed", "portfolio-empty", "portfolio-derive-threw",
  "unit-manifest-unchanged", "bundle-empty",
]));

// The wrapper-stripped forms of a reason: itself, and (when it carries one) the reason under ONE release wrapper.
function wrapperForms(r) {
  const out = [r];
  for (const w of ROUTE_REASON_WRAPPERS) if (r.startsWith(w) && r.length > w.length) out.push(r.slice(w.length));
  return out;
}

/** True when a reason (or the reason under one release wrapper) is in ROUTE_REASON_VOCABULARY (exact or ':'-prefix). */
export function routeVocabularyMatch(reason) {
  const r = S(reason);
  if (!r) return false;
  for (const c of wrapperForms(r)) {
    if (ROUTE_REASON_VOCABULARY.has(c)) return true;
    for (const e of ROUTE_REASON_VOCABULARY) if (e.endsWith(":") && c.startsWith(e) && c.length > e.length) return true;
  }
  return false;
}

/** The first REASON_RULE a route reason matches in ANY execution state (the static completeness suite's rule check), or null. */
export function routeReasonRule(reason, ctx = {}) {
  const r = S(reason);
  const c = { routeKind: "route-cli", ...ctx };
  for (const rule of REASON_RULES) for (const st of [STATES.PROVENANCE, STATES.DEPENDENCY, STATES.FAILED_DERIVE, STATES.FAILED_PUBLISH, STATES.FAILED_READBACK]) if (rule.test(r, st, c)) return rule.id;
  return null;
}

/** True when a route reason is typed: matched by a REASON_RULE or in the explicit route vocabulary. */
export function routeReasonKnown(reason, ctx = {}) {
  return routeReasonRule(reason, ctx) != null || routeVocabularyMatch(reason);
}

// The DEFERRED_DEPENDENCY families shared by both paths (ffb035b classifyDeferral, unchanged).
function legacyDeferral(r) {
  if (/^controls-(not-opened|unresolved|open-threw|apply-error)|CONTROL_LEASE|lease-lost|leaseLost|control-apply|CONTROL_PLANE|^claim-held/i.test(r)) return CLASSES.CONTENTION;
  if (/^deadline-cleanup-reserved/i.test(r)) return CLASSES.NOT_ATTEMPTED;
  if (/^deadline|^out-of-time|^aborted/i.test(r)) return CLASSES.TIMEOUT;
  if (/^cycle-not-running/i.test(r)) return CLASSES.TERMINAL_CYCLE;
  return null;
}
// The FAILED_* families shared by both paths (ffb035b classifyFailure, minus its catch-all).
function legacyFailure(state, r) {
  if (/^cycle-not-running/i.test(r)) return CLASSES.TERMINAL_CYCLE;
  if (/malformed|conflict|integrity|dangling|mismatch|invalid|payload-unreadable|not-d1|corrupt/i.test(r)) return CLASSES.INTEGRITY;
  if (state === STATES.FAILED_READBACK || /readback/i.test(r)) return CLASSES.READBACK_MISMATCH;
  if (/threw|timeout|ETIMEDOUT|ECONN|EAI_AGAIN|fetch|network|socket|5\d\d|429|failed|error/i.test(r)) return CLASSES.TRANSPORT;
  return null;
}

// ---- the LEGACY whitelist (legacy-cli routes ONLY) ---------------------------------------------------------------
// The DEFERRED_PROVENANCE / DEFERRED_DEPENDENCY vocabulary of the four legacy families: a legacy deferral carrying one
// of these is classified by its state WITHOUT an 'unmapped-reason' alert (the ffb035b semantics, unchanged). NARROWED
// (WP11 fixer P2b): the old pattern (/missing|unavailable|evidence|snapshot|catalog|.../) matched almost any code; this
// one admits only the legacy families' own code SHAPES -- a source/family-prefixed code, a 'no-' code, a
// '<sourceKey>:<retryable blocker>' readiness code (source-priority-release-runner.js blockerCodes) or one of the
// '<report>:<source>' dependency codes the legacy releases name (daily-reporting / listing-health-v3) -- and every other
// legacy code is ENUMERATED in LEGACY_REASON_CODES (scripts/recovery-classify-vocabulary.test.js proves the legacy
// verdicts -- class AND alert -- identical to the pre-fix classifier over every literal of the legacy family modules).
export const LEGACY_PROVENANCE_RE = new RegExp(
  "^(?:bundle-)?(?:oli|ads|fba|awd|catalog|listings|listings-raw|order-line-items|product-catalog|fba-inventory-health)(?:[-:]|$)"
  + "|^daily-reporting:(?:catalog|oli-sales)$|^listing-health-v3:(?:listings|listings-raw)$"
  + "|^no-[a-z0-9]"
  + "|^[a-z][a-z0-9-]*:(?:ads-coverage-incomplete|ads-coverage-no-accounts|ads-coverage-read-not-ok|ads-coverage-window-malformed|ads-coverage-windows-not-array|ads-evidence-missing|backfill-start-not-reached|coverage-incomplete|no-accounts|no-validated-snapshot|source-unavailable)$",
);

// The four legacy families' + the shared core's typed reason CODES (the leading code before any ':'), collected from
// saved-data-reconciler.js, publication-binding.js and the family releases: a DEFERRED_* state carrying one of them is
// classified by its state WITHOUT an 'unmapped-reason' alert (the ffb035b semantics, unchanged). 'derive-not-ready' is
// admitted ONLY bare (the legacy runner's reason: source-priority-release-runner.js) -- a 'derive-not-ready:<sub>' is
// admitted only for an ENUMERATED legacy sub-code (LEGACY_DERIVE_NOT_READY_SUBCODES), never as a blanket prefix.
export const LEGACY_REASON_CODES = Object.freeze(new Set((
  "aborted account-meta-threw account-meta-unresolved account-mismatch ads-coverage-read-threw ads-evidence-unavailable ads-metric-malformed "
  + "alias-write-failed as-of-before-inventory as-of-invalid authorization-malformed authorization-region-mismatch authorization-unreadable "
  + "batch-not-yet-saved binding-malformed binding-threw binding-unavailable brand-inventory-derive-refused bundle-recheck-threw "
  + "bundle-resolve-threw catalog-dangling catalog-durable-missing catalog-hash-unresolved catalog-row-count-invalid catalog-rows-unavailable "
  + "catalog-snapshot-read-threw catalog-stale claim-held claim-threw collaborator-threw connection-mismatch controls-apply-error "
  + "create-count-not-one creates-exceed-authorization current-predicate-invalid current-predicate-threw cycle-claim-threw cycle-not-running "
  + "cycle-open-threw cycle-read-threw cycle-reclaim-read-threw cycle-refresh-blank cycle-unresolved daily-derive-refused daily-not-d1 "
  + "data-unavailable deadline-aborted derive-not-ready directory-incomplete directory-missing duplicate-directory-row durable-oli-provenance-missing "
  + "eligible-without-deps evidence-missing expand-units-threw expected-request-hash-unresolved export-id-already-saved fba-durable-missing "
  + "fba-expected-hash-unresolved fba-payload-dangling fba-payload-unreadable fba-rows-invalid fba-snapshot-incomplete fba-snapshot-not-d1 "
  + "fba-snapshot-read-threw gate-account-noncanonical gate-account-prefixed gate-accounts-empty gate-accounts-threw identity-asof-threw "
  + "identity-blank identity-unresolved incomplete-account-boundary inventory-asof-invalid isolation-rejected lineage-id-missing lineage-read-threw "
  + "live-missing live-older-asof live-unverified manifest-differs marketplace-mismatch membership-exceeds-authorization no-authoritative-marketplace "
  + "no-authorization no-catalog-snapshot no-cycle no-directory-country no-durable-fba-snapshot no-durable-snapshot no-eligible-jobs no-fence "
  + "no-inventory-source no-live-identity no-owners no-reference no-revision-id not-failed not-lease-capable not-oli not-opened not-primary "
  + "object-path-builder-missing oli-coverage-read-threw oli-history-read-threw oli-history-unavailable oli-window-unresolved org-mismatch "
  + "org-unreadable out-of-time owner-incomplete path-namespace-mismatch path-sha-mismatch payload-sha-blank persist-threw prepare-result-malformed "
  + "prepare-unconfirmed pricing-revision-stale proof-threw publish-guard-malformed publish-result-malformed raw-seller-unresolved read-failed "
  + "readback-threw release-threw renew-error renew-threw replay-binding-mismatch request-hash-blank request-malformed resolver-null "
  + "revision-malformed revision-missing revision-threw row-count-invalid run-evidence-not-durable safe-close-error sales-asof-unresolved "
  + "selector-malformed served-check-invalid served-check-threw shadow-hash-provenance shadow-identity shadow-missing shadow-not-this-revision "
  + "shadow-params-identity shadow-payload-invalid shadow-payload-unavailable shadow-refresh-blank shadow-target-identity snapshot-content-hash-blank "
  + "snapshot-not-d1 snapshot-request-hash-blank snapshot-row-count-invalid source-cache-miss source-key-mismatch stage-not-create target-asof-unresolved "
  + "terminal tokens-exceed-authorization unit-asof-invalid unit-deferred-invalid unit-duplicate unit-key-invalid unit-live-account-invalid "
  + "unit-not-object unit-owners-invalid unit-report-keys-invalid unit-target-invalid units-invalid units-not-array validated-at-invalid "
  + "verdict-malformed verdict-threw verify-bundle-unresolved controls-unresolved controls-open-threw served-check-threw evidence-unreadable "
  + "epoch-not-current-d1 directory-missing account-out-of-region "
  // WP11 fixer: the legacy family literals the old broad pattern admitted that the narrowed LEGACY_PROVENANCE_RE shapes do
  // not (harvested from the legacy family modules; pinned by the vocabulary suite's legacy-identity proof).
  + "controls-close-unresolved coverage-incomplete daily-window-unresolved empty-content-deps job-bucket-unresolved live-payload-unavailable missing "
  + "publish-missing-live-identity revision-advanced-at-entry revision-advanced-before-write source-evidence source-revision-changed source-unavailable "
  + "unavailable units-empty "
  // Observe-only soak 2026-09-28 (europe-au 572a7b1b, c3092b8c): the OLI lineage resolver's (source-durable-model.js
  // resolveOliLineageProvenance) MISSING verdict for a zero-sales account whose succeeded row_count=0 exports do not
  // GAPLESSLY cover [oliStart..as-of] -- zero sales cannot be PROVEN for part of the window, i.e. missing UPSTREAM proof.
  // It closes only when the uncovered slice gets a proven zero-row export: a gap at the window's END closes with the next
  // daily export, but a slice whose export has rows without positive sales (zero-amount / cancelled / pending lines) can
  // keep it open -- visible as missing-source in the hand-off matrix. A typed MISSING_EVIDENCE deferral, never an export
  // and never a zero payload.
  // Its integrity siblings (positive-row-missing-hash, zero-row-proof-malformed, bad-derivation-window) stay UNMAPPED on
  // purpose: a malformed durable proof is a defect signal and keeps its 'unmapped-reason' alert.
  + "zero-row-window-gap"
).split(" ").filter(Boolean)));
// The legacy 'derive-not-ready:<sub>' sub-codes. EMPTY by evidence: the legacy families' runner emits 'derive-not-ready'
// BARE (or a '<sourceKey>:<reason>' / 'derive:<integrity>' blocker code), never a 'derive-not-ready:' prefix.
export const LEGACY_DERIVE_NOT_READY_SUBCODES = Object.freeze(new Set([]));
/** True when a reason's leading code is part of the documented LEGACY (legacy-cli) vocabulary. */
export function isKnownLegacyReason(reason) {
  const r = S(reason);
  if (r.startsWith("derive-not-ready:")) return LEGACY_DERIVE_NOT_READY_SUBCODES.has(r.slice("derive-not-ready:".length).split(":")[0]);
  const code = r.split(":")[0];
  return LEGACY_REASON_CODES.has(code) || LEGACY_REASON_CODES.has(code.replace(/^(bundle-|derive-not-ready-)/, "")) || LEGACY_PROVENANCE_RE.test(r);
}

const verdictOf = (cls, reason, alert, note = null) => ({ cls, reason: reason == null || reason === "" ? null : S(reason), alert: alert || null, note: note || null });
const unmapped = (r, fallback) => "unmapped-reason:" + (r.slice(0, 80) || fallback);

/**
 * Classify ONE (state, reason) of a unit x report. ctx: { routeId?, routeKind? ('legacy-cli' | 'route-cli'),
 * skuMovementServeAttested?, argAsOf?, expectedAsOf? }. -> { cls, reason, alert, note } (alert: null | a machine code;
 * note: an informational code, e.g. fba-plan's 'awaiting-next-fba-fetch'). NEVER current for an unknown reason / state.
 * A route-cli reason (routeKind !== 'legacy-cli') is typed ONLY by REASON_RULES or ROUTE_REASON_VOCABULARY.
 */
export function classifyReason(state, reason, ctx = {}) {
  const c = ctx && typeof ctx === "object" ? ctx : {};
  const st = S(state);
  const r = S(reason);
  if (st === STATES.CURRENT) {
    if (r === "" || CURRENT_REASONS.includes(r)) return verdictOf(CLASSES.CURRENT, r || null, null);
    // returns-v3: '<binding reason>:source-stale-manual' on a current binding -> verified + alert.
    if (r === SOURCE_STALE_MANUAL || r.endsWith(":" + SOURCE_STALE_MANUAL)) {
      const base = r === SOURCE_STALE_MANUAL ? "" : r.slice(0, -(SOURCE_STALE_MANUAL.length + 1));
      if (base === "" || CURRENT_REASONS.includes(base)) return verdictOf(CLASSES.CURRENT, r, SOURCE_STALE_MANUAL);
    }
    return verdictOf(CLASSES.UNKNOWN, r, unmapped(r, "blank"));
  }
  // STALE: the live pass is the honest next step. fba-plan's predicate 'content-derive-failed' (a durable derive threw
  // while proving content equivalence) stays STALE -- the prepare re-derives and fails TYPED if it throws again -- but
  // is alerted (a derive throwing on saved evidence is a defect signal).
  if (st === STATES.STALE) return verdictOf(CLASSES.STALE, r || "stale", r.endsWith(SOURCE_STALE_MANUAL) ? SOURCE_STALE_MANUAL : r === "content-derive-failed" ? "content-derive-failed" : null);
  if (st === STATES.PUBLISHED || st === STATES.READBACK_VERIFIED) return verdictOf(CLASSES.PUBLISHED_UNVERIFIED, r || null, null);
  const known = DEFERRED_STATES.has(st) || FAILED_STATES.has(st);
  if (!known) return verdictOf(CLASSES.UNKNOWN, "unrecognized-state:" + st.slice(0, 40), "unrecognized-state");
  for (const rule of REASON_RULES) {
    if (!rule.test(r, st, c)) continue;
    const cls = typeof rule.cls === "function" ? rule.cls(r, st, c) : rule.cls;
    const alert = typeof rule.alert === "function" ? rule.alert(r, st, c) : rule.alert;
    return verdictOf(cls, typeof rule.reason === "function" ? rule.reason(r, st, c) : r, alert, typeof rule.note === "function" ? rule.note(r, st, c) : null);
  }
  const legacy = isLegacy(c);
  // Typed WITHOUT an unmapped alert: a legacy family's reason by the legacy whitelist; a route reason ONLY by the
  // explicit route vocabulary.
  const typed = r !== "" && (legacy ? isKnownLegacyReason(r) : routeVocabularyMatch(r));
  if (st === STATES.DEPENDENCY) {
    const d = legacyDeferral(r);
    if (d) return verdictOf(d, r || "deferred-dependency", null);
    // A route deferral whose typed code says a read / write THREW is a transient failure (bounded retry), never a
    // silent unbounded dependency loop.
    if (!legacy && typed && /-threw(?::|$)/.test(r)) return verdictOf(CLASSES.TRANSPORT, r, null);
    return verdictOf(CLASSES.DEPENDENCY, r || "deferred-dependency", typed ? null : unmapped(r, "blank"));
  }
  if (st === STATES.PROVENANCE) {
    const d = legacyDeferral(r);
    if (d) return verdictOf(d, r, null);
    return verdictOf(CLASSES.MISSING_EVIDENCE, r || "provenance-ineligible", typed ? null : unmapped(r, "blank"));
  }
  const f = legacyFailure(st, r);
  if (f && (legacy || typed)) return verdictOf(f, r || st, f === CLASSES.INTEGRITY || f === CLASSES.TERMINAL_CYCLE ? f : null);
  // A typed route failure no failure pattern names (e.g. payload-too-large, publisher-unavailable, not-successful): the
  // release made it NON-retryable on purpose and the SAME evidence reproduces it -> integrity (dead for this token) +
  // alert. An untyped one (either path) is an unmapped typed deferral + alert.
  if (!legacy && typed) return verdictOf(CLASSES.INTEGRITY, r, CLASSES.INTEGRITY);
  return verdictOf(CLASSES.UNKNOWN, r || st, unmapped(r, st));
}

/**
 * The SERVED read-back proof of ONE unit (TARGETS v2): true when its served row carries the unit's own h (+ sra when
 * the unit has one); false when the unit carries served fields that do not prove it (no served row, or another h /
 * sra); null when the unit carries NO served fields at all (a legacy v1 unit -- its proof is the worker's tier-1 check).
 */
export function unitServedProof(u) {
  const unit = u && typeof u === "object" ? u : {};
  const sv = unit.served && typeof unit.served === "object" ? unit.served : null;
  if (!sv && unit.h == null && unit.sra == null) return null;
  return !!(sv && unit.h != null && S(sv.h) !== "" && S(sv.h) === S(unit.h) && (unit.sra == null || S(sv.sra) === S(unit.sra)));
}

/**
 * The verdict of ONE normalized (v2) target over `reportKeys` (every key must appear in some unit; missing -> unknown):
 * the WORST unit x report wins the FINAL class. -> { cls, reason, alert, alerts, note, rows, token, anyStale, staleUnits,
 * servedConfirmed }. anyStale / staleUnits: the units the live pass must repair (whatever the worst class). ctx.routeKind
 * selects the served-proof rule: STRICT by default (route-cli AND an omitted / unknown kind: per unit -- a current unit
 * without its own served read-back is 'current-unserved'; WP11 verifier F8, like classifyReason's route default); ONLY
 * the explicit legacy kind ('legacy-cli') defers a served-field-less unit to ctx.servedConfirmed === true (else null).
 */
export function jobVerdict(target, reportKeys = null, ctx = {}) {
  const c = ctx && typeof ctx === "object" ? ctx : {};
  const t = target && typeof target === "object" ? target : {};
  const units = Array.isArray(t.units) ? t.units : [];
  const keys = Array.isArray(reportKeys) && reportKeys.length ? reportKeys : null;
  const token = t.tok == null ? null : S(t.tok);
  const empty = { anyStale: false, staleUnits: [], servedConfirmed: null };
  if (S(t.r) === TARGETS_UNITS_EMPTY || units.length === 0) {
    const v = classifyReason(STATES.DEPENDENCY, TARGETS_UNITS_EMPTY, c);
    return { ...v, alerts: v.alert ? [v.alert] : [], rows: [], token, ...empty };
  }
  const rows = units.filter((u) => u && (!keys || keys.includes(S(u.rk))));
  const missing = keys ? keys.filter((k) => !rows.some((u) => S(u.rk) === k)) : [];
  if (missing.length || !rows.length) {
    return { cls: CLASSES.UNKNOWN, reason: missing.length ? "report-missing-from-targets:" + missing.join(",") : "no-reports", alert: "report-missing-from-targets", alerts: ["report-missing-from-targets"], note: null, rows: [], token, ...empty };
  }
  // STRICT unless the caller says 'legacy-cli' explicitly (an omitted kind never accepts ctx.servedConfirmed leniently).
  const strict = !isLegacy(c);
  let servedConfirmed = true;
  const classified = rows.map((u) => {
    let v = classifyReason(u.s, u.r, c);
    if (v.cls === CLASSES.CURRENT) {
      const unitProof = unitServedProof(u);
      // A route CLI's (or an unspecified kind's) current unit REQUIRES its own served read-back; a LEGACY (v1) unit defers
      // to the worker's tier-1 served confirmation (its class stays current: the verification tier-1 is anchored to).
      const proof = strict || unitProof !== null ? unitProof === true : c.servedConfirmed === true ? true : null;
      if (proof === false) { v = verdictOf(CLASSES.CURRENT_UNSERVED, "current-unserved", "current-unserved"); servedConfirmed = false; }
      else if (proof === null && servedConfirmed === true) servedConfirmed = null;
    }
    return { u: S(u.u), rk: S(u.rk), s: S(u.s), r: u.r == null ? null : S(u.r), ...v };
  });
  let worst = classified[0];
  for (const x of classified) if (classRank(x.cls) > classRank(worst.cls)) worst = x;
  const alerts = [...new Set(classified.map((x) => x.alert).filter(Boolean))].sort();
  const staleUnits = classified.filter((x) => x.cls === CLASSES.STALE).map((x) => ({ u: x.u, rk: x.rk }));
  return {
    cls: worst.cls, reason: worst.reason, alert: worst.alert, alerts, note: worst.note || null, rows: classified, token,
    anyStale: staleUnits.length > 0, staleUnits, servedConfirmed: worst.cls === CLASSES.CURRENT ? servedConfirmed : null,
  };
}

/** v1 COMPAT: a v1 TARGETS account (a LEGACY family by definition) -> the v2 jobVerdict of its normalized target. */
export function accountVerdict(account, reportKeys, ctx = {}) {
  const norm = normalizeTargets({ v: 1, family: "", bucket: "", requestedAsOf: "", accounts: [account || {}] });
  const target = norm && norm.targets[0] ? norm.targets[0] : { id: S(account && account.id), units: [] };
  // v1 semantics: an account with NO report entries is "no-reports" (never an implicit units-empty pass).
  if (!target.units.length) return { cls: CLASSES.UNKNOWN, reason: "no-reports", alert: "report-missing-from-targets", alerts: ["report-missing-from-targets"], note: null, rows: [], token: null, anyStale: false, staleUnits: [], servedConfirmed: null };
  return jobVerdict(target, reportKeys, { routeKind: LEGACY_ROUTE_KIND, ...ctx });
}

/** COMPAT: a DEFERRED_DEPENDENCY reason -> class (the v2 reason rules + the path's vocabulary; ctx.routeKind selects it). */
export function classifyDeferral(reason, ctx = {}) {
  const v = classifyReason(STATES.DEPENDENCY, reason, ctx);
  return { cls: v.cls, reason: v.reason || S(reason) || "deferred-dependency", alert: v.alert };
}

/** COMPAT: a FAILED_* state + reason -> class. */
export function classifyFailure(state, reason, ctx = {}) {
  const st = FAILED_STATES.has(S(state)) ? S(state) : STATES.FAILED_DERIVE;
  const v = classifyReason(st, reason, ctx);
  return { cls: v.cls, reason: v.reason || S(state), alert: v.alert };
}

// Classes that ALWAYS raise an operator alert (on top of any reason-level alert).
const ALERT_CLASSES = new Set([CLASSES.ROUTE_NOT_ACTIVATED, CLASSES.ZERO_EXPORT_VIOLATION, CLASSES.INTEGRITY, CLASSES.CONFIG_ALERT, CLASSES.TERMINAL_CYCLE, CLASSES.SERVED_ROW_PREEMPTED, CLASSES.CAPACITY_EXCEEDED, CLASSES.AWAIT_TIMEOUT, CLASSES.UNKNOWN, CLASSES.CURRENT_UNSERVED]);

/**
 * Map a class to the durable finish outcome + backoff (seconds) + alert flag. `attempt` = executed attempts so far.
 * Deferrals never consume an attempt; retries back off exponentially (capped at maxBackoff).
 */
export function outcomeFor(cls, { attempt = 0, baseBackoff = 60, maxBackoff = 3600 } = {}) {
  const exp = Math.min(maxBackoff, baseBackoff * Math.pow(2, Math.max(0, attempt)));
  const alert = ALERT_CLASSES.has(cls);
  switch (cls) {
    case CLASSES.CURRENT: return { outcome: "verified", backoff: 0, alert };
    case CLASSES.CONTENTION: case CLASSES.NOT_ATTEMPTED: return { outcome: "deferred", backoff: Math.min(maxBackoff, 120), alert };
    case CLASSES.EVIDENCE_ADVANCED: return { outcome: "deferred", backoff: 60, alert };
    case CLASSES.DEPENDENCY: return { outcome: "deferred", backoff: Math.min(maxBackoff, 900), alert };
    // A route CLI's current binding whose served read-back is unproven: re-checked, never verified (alerted).
    case CLASSES.CURRENT_UNSERVED: return { outcome: "deferred", backoff: Math.min(maxBackoff, 900), alert };
    case CLASSES.MISSING_EVIDENCE: return { outcome: "deferred", backoff: Math.min(maxBackoff, 1800), alert };
    case CLASSES.UNKNOWN: return { outcome: "deferred", backoff: 1800, alert };
    case CLASSES.CONFIG_ALERT: return { outcome: "deferred", backoff: 600, alert };
    case CLASSES.SERVED_ROW_PREEMPTED: return { outcome: "deferred", backoff: 3600, alert };
    case CLASSES.CAPACITY_EXCEEDED: return { outcome: "deferred", backoff: 21600, alert };
    // Never terminal: the SAME evidence must publish once the owner attests (a dead job would refuse that token).
    case CLASSES.ROUTE_NOT_ACTIVATED: return { outcome: "deferred", backoff: 3600, alert };
    case CLASSES.AWAIT_TIMEOUT: return { outcome: "proceed", backoff: 0, alert };
    // Terminal for THIS evidence token: the store's 'dead' + 'dead-same-evidence' refuses re-enqueueing the SAME token
    // (never a loop) while a CHANGED token opens a new job. Never counted as published (hand-off: deferred /
    // not-applicable, never failed -- see handoffClass).
    case CLASSES.SUPERSEDED_NEWER_LIVE: case CLASSES.NOT_APPLICABLE: return { outcome: "dead", backoff: 0, alert };
    case CLASSES.TERMINAL_CYCLE: case CLASSES.INTEGRITY: case CLASSES.ZERO_EXPORT_VIOLATION: return { outcome: "dead", backoff: 0, alert };
    case CLASSES.TIMEOUT: case CLASSES.TRANSPORT: case CLASSES.READBACK_MISMATCH: case CLASSES.RUN_FAILED: case CLASSES.PUBLISHED_UNVERIFIED: case CLASSES.STALE:
      return { outcome: "retry", backoff: exp, alert };
    default: return { outcome: "deferred", backoff: 1800, alert: true }; // an unknown class is a typed deferral + alert
  }
}

/**
 * The owner HAND-OFF class of a verdict class. already-current / repaired REQUIRE the served read-back
 * (servedConfirmed === true): a current verdict without it (a legacy verification awaiting the tier-1 served-row check,
 * a revoked served proof) is 'deferred' (typed current-unserved). `published` = this job's own live pass published and a
 * verify pass then proved it current (repaired). ROUTE_NOT_ACTIVATED is 'deferred' (applicable -- just not activated).
 */
export function handoffClass(cls, { published = false, servedConfirmed = null } = {}) {
  switch (cls) {
    case CLASSES.CURRENT:
      if (servedConfirmed !== true) return HANDOFF_CLASSES.DEFERRED;
      return published ? HANDOFF_CLASSES.REPAIRED : HANDOFF_CLASSES.ALREADY_CURRENT;
    case CLASSES.MISSING_EVIDENCE: return HANDOFF_CLASSES.MISSING_SOURCE;
    case CLASSES.NOT_APPLICABLE: return HANDOFF_CLASSES.NOT_APPLICABLE;
    case CLASSES.INTEGRITY: case CLASSES.ZERO_EXPORT_VIOLATION: case CLASSES.TERMINAL_CYCLE: case CLASSES.READBACK_MISMATCH:
    case CLASSES.RUN_FAILED: case CLASSES.TIMEOUT: case CLASSES.TRANSPORT: case CLASSES.PUBLISHED_UNVERIFIED: case CLASSES.CONFIG_ALERT:
      return HANDOFF_CLASSES.FAILED;
    // stale-pending, superseded, preempted, capacity, contention, dependency, re-armed, current-unserved,
    // route-not-activated, unclassified
    default: return HANDOFF_CLASSES.DEFERRED;
  }
}

/** The live pass a STALE verdict needs: 'repair' (--live --verify-exact) for a manifest drift, else 'live'. */
export function repairKindFor(verdict) {
  const rows = verdict && Array.isArray(verdict.rows) ? verdict.rows : [];
  return rows.some((x) => x.cls === CLASSES.STALE && S(x.r) === "manifest-differs") ? "repair" : "live";
}

// The route CLI STOP codes that mean "this route is not activated here" (an owner attestation / fence env not exactly
// 'true') -> route-not-activated (config; deferred hand-off), never a failure loop. EXPLICIT, read from the emitters:
// NONE of the five allowed worker CLIs (publication-route-reconcile.mjs and the four legacy reconcilers) STOPs on an
// attestation -- fba-plan's unattested fence surfaces PER UNIT ('derive-threw:fba-plan-route-fence-not-attested:' /
// bare from its publishGuard), sku-movement's as 'served-row-preempted:serve-rederives'. So every STOP is a run failure +
// alert; scripts/recovery-classify-vocabulary.test.js scans the CLIs' STOP codes and fails if one that looks like an
// activation gate appears without being listed here.
export const NOT_ACTIVATED_STOP_CODES = Object.freeze(new Set([]));
// The route CLI STOP codes that mean "a target left the region's durable directory between the worker's scope check and
// the child's own fresh directory read" (scripts/release/publication-route-reconcile.mjs: an explicit --targets entry
// outside the route's scope; the worker drops out-of-scope account targets BEFORE spawning -- worker.js -- so this is the
// residual directory-cache race, PRW directory TTL 600 s). -> a typed DEPENDENCY deferral (900 s > the TTL, so the next
// claim sees the refreshed directory and supersedes the stale target) that consumes NO attempt + alert
// 'route-target-out-of-scope'; never RUN_FAILED (one stale target must not burn / dead-letter its whole batch).
export const SCOPE_RACE_STOP_CODES = Object.freeze(new Set(["ROUTE_TARGET_OUT_OF_SCOPE"]));
// runRoute's typed argv refusals (runner.js re-exports these as ARGS_ERROR_*).
export const RUN_ARGS_ERRORS = Object.freeze({ FBA_PLAN_AS_OF_ROLLED: "fba-plan-as-of-rolled", REFUSED: "argv-refused" });

/**
 * Classify a finished child run (process level) before looking at per-target states. Returns null when the run is
 * well-formed (per-target classification applies), else ONE class for EVERY job in the batch: { cls, reason, alert }.
 */
export function classifyRun(run) {
  if (!run) return { cls: CLASSES.TRANSPORT, reason: "no-run", alert: null };
  // A refused argv never spawned a child (runRoute argsError): the fba-plan UTC-midnight roll re-arms (the next claim
  // supersedes the job under the new epoch); any other refusal is the worker's own invocation defect.
  if (run.argsError) {
    if (S(run.argsError) === RUN_ARGS_ERRORS.FBA_PLAN_AS_OF_ROLLED) return { cls: CLASSES.EVIDENCE_ADVANCED, reason: "as-of-rolled:" + RUN_ARGS_ERRORS.FBA_PLAN_AS_OF_ROLLED, alert: null };
    return { cls: CLASSES.CONFIG_ALERT, reason: RUN_ARGS_ERRORS.REFUSED, alert: RUN_ARGS_ERRORS.REFUSED };
  }
  if (run.spawnError) return { cls: CLASSES.TRANSPORT, reason: "spawn-failed", alert: null };
  const t = run.targets;
  const res = run.result;
  // Structural zero-export tripwire FIRST (a blocked request + a later timeout is still a violation).
  const blocked = Math.max(Number(run.zeroExport && run.zeroExport.blocked) || 0, Number(res && res.zeroExport && res.zeroExport.blocked) || 0);
  if (blocked > 0) return { cls: CLASSES.ZERO_EXPORT_VIOLATION, reason: "zero-export-guard-blocked:" + blocked, alert: "zero-export-violation" };
  if ((res && (Number(res.dataDoeCreates) > 0 || Number(res.dataDoeTokens) > 0)) || (t && (Number(t.dataDoeCreates) > 0 || Number(t.dataDoeTokens) > 0))) {
    return { cls: CLASSES.ZERO_EXPORT_VIOLATION, reason: "reconciler-reported-datadoe-spend", alert: "zero-export-violation" };
  }
  if (run.capacityExceeded) return { cls: CLASSES.CAPACITY_EXCEEDED, reason: "capacity-exceeded:" + S(run.capacityExceeded), alert: "capacity-exceeded" };
  if (run.oom) return { cls: CLASSES.CAPACITY_EXCEEDED, reason: "capacity-exceeded:child-oom", alert: "capacity-exceeded" };
  if (run.timedOut) return { cls: CLASSES.TIMEOUT, reason: "child-hard-timeout", alert: null };
  if (!t && run.stop && run.stop.code) {
    const code = S(run.stop.code);
    if (NOT_ACTIVATED_STOP_CODES.has(code)) return { cls: CLASSES.ROUTE_NOT_ACTIVATED, reason: "route-not-activated:" + code, alert: "route-not-activated" };
    if (SCOPE_RACE_STOP_CODES.has(code)) return { cls: CLASSES.DEPENDENCY, reason: "route-target-out-of-scope:" + code, alert: "route-target-out-of-scope" };
    return { cls: CLASSES.RUN_FAILED, reason: "stop:" + code, alert: "route-cli-stop" };
  }
  if (!t) return { cls: CLASSES.TRANSPORT, reason: res ? "no-targets-line:" + S(res.code || res.outcome) : "no-result-line:exit-" + S(run.exitCode), alert: null };
  const norm = normalizeTargets(t);
  const count = norm ? norm.targets.length : (Array.isArray(t.accounts) ? t.accounts.length : (Array.isArray(t.targets) ? t.targets.length : 0));
  // A whole-run failure (saved-data-reconciler fail(): outcome failed, a typed code, NO targets) is ONE run class. With
  // per-target entries the targets are classified individually (never masked as one run failure).
  if (S(norm ? norm.outcome : t.outcome) === "failed" && count === 0) {
    const code = S((norm ? norm.code : t.code) || (res && res.code)) || "failed";
    const f = legacyFailure(STATES.FAILED_DERIVE, code);
    return f === CLASSES.INTEGRITY ? { cls: CLASSES.INTEGRITY, reason: "run-failed:" + code, alert: "integrity" } : { cls: CLASSES.RUN_FAILED, reason: "run-failed:" + code, alert: null };
  }
  if (!norm) return { cls: CLASSES.UNKNOWN, reason: "targets-malformed", alert: "targets-malformed" };
  return null;
}

/** The normalized (v2) targets of a well-formed run, keyed by target id (a missing target is NEVER assumed current). */
export function runTargets(run) {
  const norm = run && run.targets ? normalizeTargets(run.targets) : null;
  return new Map((norm ? norm.targets : []).map((x) => [S(x.id), x]));
}

/** The reconciler reported that its own control cleanup did not complete (the run token must be cleaned up). */
export function cleanupUnresolved(run) {
  if (!run) return false;
  return (run.targets && run.targets.controlCleanupUnresolved === true) || S(run.result && run.result.code) === "CONTROL_CLEANUP_UNRESOLVED";
}

/** The await escape hatch: an awaited route still open after maxMinutes -> proceed + 'await-timeout' alert. */
export function awaitVerdict({ openSinceMs, nowMs, maxMinutes }) {
  const waited = Number(nowMs) - Number(openSinceMs);
  if (!Number.isFinite(waited) || waited < Number(maxMinutes) * 60000) return { cls: CLASSES.DEPENDENCY, reason: "awaiting-upstream-route", alert: null };
  return { cls: CLASSES.AWAIT_TIMEOUT, reason: "await-timeout", alert: "await-timeout" };
}
