// Publication recovery WP11 fixer -- the ROUTE REASON VOCABULARY is COMPLETE and the legacy verdicts are UNCHANGED
// (FAIL-CLOSED, static; ZERO network / DB / DataDoe):
//   V1 a static literal scan of every route reason EMITTER (route-publication-release.js, the six
//      lib/server/sync/routes/*.release.js, the ten lib/server/recovery/routes/*.route.js, fba-plan-dependency-bundle.js,
//      saved-data-reconciler.js, publication-binding.js, reconcile-targets-output.js and the reason-producing helpers the
//      routes call: returns-publish.js, sku-movement-durable-rederive.js, report-materialization-brandview-composition.js,
//      live-promoted-resolver.js, serve-selectors.js) finds EVERY code-shaped string literal either TYPED for a route
//      (a REASON_RULE or ROUTE_REASON_VOCABULARY), a documented SUB-CODE that is typed under its wrapper prefix, a
//      LEGACY-ONLY reason of the shared core that the legacy whitelist types, or an EXPLICIT non-reason literal (an
//      identifier / token prefix / stage / disposition / internal state) -- a new reason literal breaks this suite until
//      it is classified (like recovery-registry-completeness does for report keys);
//   V2 the four legacy families' verdicts (class AND alert) are IDENTICAL to the pre-fix classifier (frozen copy below)
//      over every code literal of the legacy family modules + LEGACY_REASON_CODES, in every execution state;
//   V3 the explicit NOT_ACTIVATED STOP list: every STOP code the five allowed worker CLIs emit is scanned -- none may
//      look like an activation gate unless listed in NOT_ACTIVATED_STOP_CODES;
//   V4 every vocabulary entry is a well-formed code and classifies (in the states it arrives in) WITHOUT an unmapped alert;
//   V1c the shared helpers' reason-bearing outputs (report-publisher dispositions + semantic identity codes, the
//      report-derivation statuses) are typed under the release wrappers that carry them (WP11 verifier F6);
//   V5 every typed code a route runtime THROWS is a listed contract-thrown tail or caught inside the runtime (the
//      leading-'-threw' rule's exception list, WP11 verifier F4).
// 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyReason, routeReasonKnown, routeVocabularyMatch, ROUTE_REASON_VOCABULARY, ROUTE_REASON_WRAPPERS, LEGACY_REASON_CODES, isKnownLegacyReason,
  NOT_ACTIVATED_STOP_CODES, SCOPE_RACE_STOP_CODES, CONTRACT_THROWN_TAIL_CODES, routeReasonRule, classifyRun, CLASSES, STATES,
} from "../lib/server/recovery/classify.js";
import { REPORT_RECOVERY_CLASSIFICATION } from "../lib/server/recovery/registry.js";
import { ROUTE_IDS, LEGACY_ROUTE_IDS, ALLOWED_WORKER_SCRIPTS } from "../lib/server/recovery/routes.js";
import { ROUTE_REGIONS } from "../lib/server/recovery/route-contract.js";
import { TARGETS_UNITS_EMPTY } from "../lib/server/sync/reconcile-targets-output.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
const S = (v) => (v == null ? "" : String(v));
const J = (x) => JSON.stringify(x);
const src = (p) => readFileSync(path.join(ROOT, p), "utf8");
writeSync(1, "recovery-classify-vocabulary\n");

// Code only: strip block + whole-line / trailing comments and import / re-export lines (a module specifier is not a code).
const stripCode = (t) => t.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, "")).replace(/(^|[^:\\"'`])\/\/.*$/gm, "$1").replace(/^\s*(import|export)\b[^;]*?\bfrom\s+["'][^"']+["'];?/gm, "");
// A code-shaped literal: lower-case kebab / colon code with at least one '-' or ':' (single words are never scanned).
const CODE_LITERAL_RE = /^[a-z][A-Za-z0-9]*(?:[-_.:][A-Za-z0-9]*)*$/;
function literalsOf(files) {
  const out = new Map();
  for (const f of files) {
    for (const line of stripCode(src(f)).split("\n")) {
      for (const m of line.matchAll(/"([^"\\\n]*)"|'([^'\\\n]*)'|`([^`$\\]*)(?:`|\$\{)/g)) {
        const s = m[1] ?? m[2] ?? m[3];
        if (!s || !/[-:]/.test(s) || !CODE_LITERAL_RE.test(s)) continue;
        if (!out.has(s)) out.set(s, new Set());
        out.get(s).add(path.basename(f));
      }
    }
  }
  return out;
}

/* V1. the route reason vocabulary is COMPLETE over the emitters */
{
  const EMITTERS = [
    "lib/server/sync/route-publication-release.js",
    ...readdirSync(path.join(ROOT, "lib/server/sync/routes")).filter((f) => f.endsWith(".release.js")).map((f) => "lib/server/sync/routes/" + f),
    ...readdirSync(path.join(ROOT, "lib/server/recovery/routes")).filter((f) => f.endsWith(".route.js")).map((f) => "lib/server/recovery/routes/" + f),
    "lib/server/sync/fba-plan-dependency-bundle.js", "lib/server/sync/saved-data-reconciler.js", "lib/server/sync/publication-binding.js", "lib/server/sync/reconcile-targets-output.js",
    "lib/server/reports/returns-publish.js", "lib/server/reports/sku-movement-durable-rederive.js", "lib/server/sync/report-materialization-brandview-composition.js",
    "lib/server/sync/live-promoted-resolver.js", "lib/server/recovery/serve-selectors.js",
    // WP11 verifier F6: the Brand View helpers the brand-view* routes call (their reason literals reach a unit verbatim).
    "lib/server/sync/brand-view-dependency-readers.js", "lib/server/reports/brand-view-dependency-fingerprint.js", "lib/server/reports/brand-directory-membership.js",
  ];
  // NOT literal-scanned wholesale (WP11 verifier F6, reviewed): lib/server/sync/report-publisher.js and
  // lib/server/sync/report-derivation.js are shared by EVERY report -- a scan adds ~90 non-reason literals (report
  // version ids, '<report>:<source>' dependency ids, the sku-pl monthly-units derivation messages of a non-route
  // report) whose churn is unrelated to the route vocabulary. Their reason-bearing outputs reach a route unit ONLY
  // through a typed release wrapper ('preflight-<disposition>', 'publish-<disposition>', 'semantic-identity:<code>',
  // fba-plan's 'derive-<status>' / 'fba-plan-derive-invalid:'), and V1c pins EVERY such value (read from the modules
  // themselves) typed under its wrapper.
  // SUB-CODES: literals that reach a TARGETS unit ONLY as the dynamic tail of a typed wrapper prefix -> typed there.
  const SUB_CODES = {
    "served-row-preempted:": ["out-of-line", "version-hidden", "foreign-row", "exact-identity-row", "other-identity", "newer-write", "scope-mismatch", "serve-rederives", "read-failed", "selector-malformed", "verdict-threw", "verdict-malformed", "served-mismatch", "verify-bundle-unresolved", "serve-flag-off", "bad-expected-d1"],
    "live-readback-failed:": ["blank-params-hash", "blank-refresh", "identity-account", "identity-hash", "identity-report-key", "live-report-key-mismatch", "live-version", "no-live-snapshot", "params-provenance", "payload-contract", "payload-dangling", "payload-unavailable", "resolver-null", "readback-threw:"],
    "units-invalid:": ["unit-asof-invalid", "unit-deferred-invalid", "unit-duplicate", "unit-key-invalid", "unit-live-account-invalid", "unit-not-object", "unit-owners-invalid", "unit-report-keys-invalid", "units-not-array"],
    "fba-pointer-integrity:": ["connection-mismatch", "cross-account-scope", "no-pointer", "org-mismatch", "path-namespace-mismatch", "path-sha-mismatch", "payload-sha-blank", "request-hash-blank", "row-count-invalid", "source-key-mismatch", "validated-at-invalid"],
    "catalog-pointer-integrity:": ["path-mismatch", "source-scope-mismatch"],
    "shadow-newer-live:": ["shadow-hash-provenance", "shadow-identity", "shadow-not-this-revision", "shadow-params-identity"],
    "superseded-newer-live:": ["served-newer-awd", "served-newer-inventory"],
    "inventory-guard:": ["fetch-unordered", "awd-fetch-unordered"],
    "controls-not-opened:": ["no-owners", "controls-apply-error:"],
    "lease-lost-before-publish:": ["renew-threw:"],
    "evidence-read-failed:": ["ads-coverage", "ads-rows", "campaign-mapping", "catalog-payload", "snapshot:", "snapshot-meta:"],
    "evidence-advanced:": ["selected-inventory"],
    "fingerprint-read-failed:": ["meta-"],
  };
  // LEGACY-ONLY reasons of the SHARED core (saved-data-reconciler.js / publication-binding.js) that only the pre-hook
  // (legacy family) path emits -- typed by the legacy whitelist, never on a route unit.
  const LEGACY_ONLY = ["release-threw", "live-missing", "live-older-asof", "live-unverified"];
  // EXPLICIT NON-REASON literals (reviewed): identifiers, token / key prefixes, CLI flags, stages, dispositions,
  // internal states, thrown messages the release reduces to another code, and reason FRAGMENTS joined with a dynamic
  // part into a vocabulary code ('claim-' + disposition, 'served-' + reason, 'derive-' + status, ...).
  const NON_REASON = {
    identifiers: ["order-line-items", "product-catalog", "fba-inventory-health", "listings-raw", "oli-operational-units", "oli-sku-asin-resolution", "campaign-ads", "campaign-brand-mapping", "brand-inventory-available", "fba-plan-oli-coverage-v1", "fba-plan:awd", "fba-plan:inventory-health", "legacy-cli", "route-cli", "region-brand", "dd-secondary", "as-of"],
    tokenPrefixes: ["bb1:", "bb:", "bbm1:", "bv1:", "bv:", "bvm1:", "pf1:", "pfm2:", "rl1:", "rm1:", "fp2:", "fpm1:", "cov:", "cat:", "cat:-", "fba:", "fba:-", "oli:", "oli:-", "lst:", "ads:", "catalog:", "directory:", "returns:", "settlement:", "opunits:", "brand-view:", "region:", "sku-movement-brand-list:", "adr1:"],
    cliFlagsAndBuckets: ["deadline-seconds", "emit-targets", "lease-wait-seconds", "prune-shadows", "run-token", "verify-exact", "bootstrap-", "bootstrap-fba-", "priority-partial-", "publication-route-reconcile:"],
    stagesAndDispositions: ["assert-no-cron", "assert-no-cron-final", "d1-not-ready", "job-save", "shadow-save", "publish-gates", "source-evidence", "catalog-evidence", "terminal-cycle", "lineage-upsert", "live-readback", "job-lineage", "saved-data", "schema-cache", "callback-error", "already-complete", "already-terminal", "adopted-newer", "not-written", "rebuilt-verified", "not-required", "not-run", "not-found", "not-opened", "lease-lost", "threw:", "derive:", "cycle-", "durable-", "oli-", "ads-", "oli-coverage", "oli-history", "ads-revision", "no-revision-id", "scope-latest"],
    // FIXABLE served-verdict reasons: the core rewrites them to 'served-row-differs' (saved-data-reconciler.js / the release).
    fixableServed: ["stale-sra", "no-compact", "serve-token-stale"],
    controlSummaries: ["control-cleanup-unresolved", "controls-unresolved", "safe-close-commit-unknown", "safe-close-error:", "safe-close-failed:", "safe-close-threw:", "termination-unconfirmed-lease-held-for-cleanup"],
    blockerVocabulary: ["ads-coverage-no-accounts", "ads-coverage-read-not-ok", "ads-coverage-window-malformed", "ads-coverage-windows-not-array", "ads-evidence-missing", "backfill-start-not-reached", "no-accounts", "no-validated-snapshot", "source-unavailable", "catalog-snapshot-missing"],
    directoryExclusions: ["not-primary", "duplicate-directory-row", "raw-seller-unresolved"],
    // the already-current proof's check details (they surface only as 'already-current-lost:<check>').
    proofInternals: ["no-stored-tokens", "live-identity", "tokens-differ", "payload-differs", "shadow-unreadable", "latest-job-not-this-evidence", "served:"],
    bindingHelperInternals: ["extra-key-collision", "extra-key-unknown", "extra-not-object", "extra-threw", "extra-value-invalid", "gate-account-noncanonical", "gate-account-prefixed", "gate-accounts-empty", "gate-accounts-threw", "invalid-report-key"],
    fillOnlyInternals: ["in-flight", "stale-in-flight", "stale-open", "not-applicable", "unavailable:", "awd-not-applicable", "as-of-before-inventory", "inputs-inconsistent"],
    thrownMessages: ["catalog-row-count-mismatch", "brand-directory-unavailable"],
    fragments: ["bundle-", "derive-not-ready:", "claim-", "finalize-", "preflight-", "publish-", "reconcile-", "served-", "derive-", "meta-", "snapshot:", "snapshot-meta:", "readback-threw:", "renew-threw:", "controls-apply-error:"],
    composeOnly: ["no-evidence-token"],
  };
  const lits = literalsOf(EMITTERS);
  const reportKeys = new Set([...REPORT_RECOVERY_CLASSIFICATION.keys()]);
  const nonReason = new Set(Object.values(NON_REASON).flat());
  const subOf = new Map(Object.entries(SUB_CODES).flatMap(([p, subs]) => subs.map((x) => [x, p])));
  const unclassified = [];
  for (const [lit, files] of lits) {
    if (reportKeys.has(lit) || ROUTE_IDS.includes(lit) || ROUTE_REGIONS.includes(lit)) continue;
    if (routeReasonKnown(lit)) continue;
    if (subOf.has(lit)) continue;
    if (LEGACY_ONLY.includes(lit)) continue;
    if (nonReason.has(lit)) continue;
    unclassified.push(lit + " [" + [...files].join(",") + "]");
  }
  ok(`V1: every code literal of the ${EMITTERS.length} route reason emitters (${lits.size} literals) is TYPED for a route (REASON_RULES / ROUTE_REASON_VOCABULARY), a sub-code of a typed wrapper, a legacy-only core reason, or an EXPLICIT non-reason literal` + (unclassified.length ? " -- UNCLASSIFIED: " + unclassified.join(" | ") : ""), unclassified.length === 0 && lits.size > 300);
  const subBad = [...subOf].filter(([x, p]) => !routeReasonKnown(p + (x.endsWith(":") || x.endsWith("-") ? x + "x" : x)));
  ok("V1: every documented SUB-CODE is typed under its wrapper prefix (e.g. served-row-preempted:foreign-row, live-readback-failed:identity-hash, units-invalid:unit-duplicate)" + (subBad.length ? " BAD " + J(subBad) : ""), subBad.length === 0);
  ok("V1: every legacy-only core reason is typed by the LEGACY whitelist (and is NOT a route vocabulary code)", LEGACY_ONLY.every((r) => isKnownLegacyReason(r) && !routeVocabularyMatch(r)));
  const stale = [...nonReason].filter((x) => ![...lits.keys()].includes(x));
  ok("V1: the explicit non-reason list carries NO stale entry (each still occurs in an emitter)" + (stale.length ? " STALE: " + stale.join(",") : ""), stale.length === 0);
  const clash = [...nonReason].filter((x) => routeReasonKnown(x) && !NON_REASON.fragments.includes(x));
  ok("V1: no non-reason literal is also a typed route reason (the lists are disjoint, fragments aside)" + (clash.length ? " CLASH: " + clash.join(",") : ""), clash.length === 0);
}

/* V1c. the reason-bearing outputs of the SHARED helpers (report-publisher dispositions + semantic identity, the
   report-derivation statuses) are typed under the release wrappers that carry them onto a route unit (WP11 verifier F6) */
{
  const { PUBLISH_DISPOSITIONS } = await import("../lib/server/sync/report-publisher.js");
  const CAS_ONLY = ["published", "already-current", "newer-live", "publish-conflict", "lease-lost", "publish-failed"];
  const failures = PUBLISH_DISPOSITIONS.filter((d) => d !== "published" && d !== "already-current");
  const preCas = PUBLISH_DISPOSITIONS.filter((d) => !CAS_ONLY.includes(d));
  const rel = src("lib/server/sync/route-publication-release.js");
  const badPub = failures.filter((d) => !routeReasonKnown("publish-" + d)).map((d) => "publish-" + d);
  const badPre = preCas.filter((d) => !routeReasonKnown("preflight-" + d)).map((d) => "preflight-" + d);
  ok("V1c: every report-publisher failure disposition (PUBLISH_DISPOSITIONS) is typed as 'publish-<d>' and every pre-CAS one as 'preflight-<d>' -- the exact wrappers route-publication-release.js builds" + (badPub.length || badPre.length ? " BAD " + J([...badPub, ...badPre]) : ""),
    failures.length >= 12 && preCas.length >= 8 && badPub.length === 0 && badPre.length === 0 && /hardFail\("publish-gates", "preflight-" \+ code\(pf && pf\.disposition\)\)/.test(rel)
    // (WP14 final review P2-1) the publish wrapper may carry the typed writer-fence suffix, which classifies 'writer-fenced'.
    && /hardFail\("publish", "publish-" \+ code\(pdisp\) \+ \(res && res\.writerFenced === true \? ":REPORT_WRITER_FENCED:" \+ publisherKey : ""\)\)/.test(rel)
    && routeReasonKnown("publish-publish-failed:REPORT_WRITER_FENCED:returns-leakage-v3"));
  const sem = [...new Set([...src("lib/server/sync/report-publisher.js").matchAll(/semFail\("([a-z0-9-]+)"\)/g)].map((m) => m[1]))];
  const badSem = sem.filter((c) => !routeReasonKnown("semantic-identity:" + c));
  ok("V1c: every report-publisher semantic-identity code (semFail) is typed as 'semantic-identity:<code>' (route-publication-release.js prepare)" + (badSem.length ? " BAD " + J(badSem) : ""),
    sem.length >= 5 && badSem.length === 0 && /hardFail\("derive", "semantic-identity:" \+ code\(sem && sem\.reason\)\)/.test(rel));
  const der = src("lib/server/sync/report-derivation.js");
  const i = der.indexOf("export function deriveReportSnapshot(");
  const body = der.slice(i, der.indexOf("\nexport ", i + 10));
  const statuses = [...new Set([...body.matchAll(/status: "([a-z-]+)"/g), ...body.matchAll(/"(blocked|unavailable)"/g)].map((m) => m[1]))].sort();
  const badDer = statuses.filter((s) => s !== "derived" && s !== "invalid" && !routeReasonKnown("derive-" + s));
  const fpRel = src("lib/server/sync/routes/fba-plan.release.js");
  ok("V1c: every report-derivation status of deriveReportSnapshot other than 'derived' is typed on the fba-plan route: 'invalid' -> the thrown 'fba-plan-derive-invalid:' (integrity), the rest -> 'derive-<status>'" + (badDer.length ? " BAD " + J(badDer) : ""),
    J(statuses) === J(["blocked", "derived", "invalid", "not-implemented", "unavailable", "unmapped"]) && badDer.length === 0 && /reason: "derive-" \+ S\(r\.status\)/.test(fpRel) && /"fba-plan-derive-invalid:"/.test(fpRel)
    && classifyReason(STATES.FAILED_DERIVE, "derive-threw:fba-plan-derive-invalid:X", { routeKind: "route-cli" }).cls === CLASSES.INTEGRITY && classifyReason(STATES.FAILED_DERIVE, "derive-threw:fba-plan-derive-invalid:X", { routeKind: "route-cli" }).alert === "derive-invalid");
}

/* V5. the CONTRACT-THROWN tails (WP11 verifier F4 exception list): every Error a route runtime THROWS whose message leads
   with a code a REASON_RULE types is either listed in CONTRACT_THROWN_TAIL_CODES (it escapes the derive and arrives as
   'derive-threw:<code>...' -> classified by its tail) or explicitly caught inside the runtime (never a 'derive-threw:'
   tail) -- so the leading-'-threw' rule can never silently re-class a deliberately typed throw. */
{
  const RUNTIMES = readdirSync(path.join(ROOT, "lib/server/sync/routes")).filter((f) => f.endsWith(".release.js")).map((f) => "lib/server/sync/routes/" + f);
  // Caught INSIDE the runtime and turned into a typed notReady reason (brand-view-portfolio.release.js derive: the
  // capacity guard's throws end in 'capacity-exceeded:<heap|deadline>' / 'deadline-aborted' notReady reasons).
  const CAUGHT_INSIDE = { "lib/server/sync/routes/brand-view-portfolio.release.js": ["aborted", "capacity-exceeded:deadline", "capacity-exceeded:heap"] };
  const thrown = [];
  for (const f of RUNTIMES) {
    const t = stripCode(src(f));
    for (const m of t.matchAll(/new Error\(\s*"([a-z][a-z0-9-]*(?::[a-z0-9-]+)?)[:" ]/g)) thrown.push([f, m[1]]);
    for (const m of t.matchAll(/new Error\(\s*([A-Z][A-Z0-9_]+) \+ "/g)) thrown.push([f, m[1]]);
  }
  const fp = await import("../lib/server/sync/routes/fba-plan.release.js");
  const resolve = (c) => (/^[A-Z]/.test(c) ? S(fp[c]) : c);
  const typedThrows = thrown.map(([f, c]) => [f, resolve(c)]).filter(([, c]) => c && routeReasonRule(c) != null);
  const unexplained = typedThrows.filter(([f, c]) => !CONTRACT_THROWN_TAIL_CODES.some((k) => c === k || c.startsWith(k + ":")) && !(CAUGHT_INSIDE[f] || []).includes(c));
  ok("V5: every typed code a route runtime THROWS is a listed CONTRACT_THROWN_TAIL_CODES entry (fba-plan's fence -> route-not-activated, its derive integrity error -> integrity, each through 'derive-threw:') or explicitly caught inside its runtime" + (unexplained.length ? " -- UNEXPLAINED: " + J(unexplained) : ""),
    unexplained.length === 0 && J(CONTRACT_THROWN_TAIL_CODES) === J(["fba-plan-route-fence-not-attested", "fba-plan-derive-invalid"]) && CONTRACT_THROWN_TAIL_CODES.every((k) => typedThrows.some(([, c]) => c === k || c.startsWith(k + ":")))
    && classifyReason(STATES.FAILED_DERIVE, "derive-threw:" + fp.FBA_PLAN_ROUTE_FENCE_NOT_ATTESTED + ": x", { routeKind: "route-cli" }).cls === CLASSES.ROUTE_NOT_ACTIVATED);
}

/* V2. the legacy families' verdicts are IDENTICAL to the pre-fix classifier (frozen copy) */
{
  // ---- FROZEN COPY of the pre-fix (WP11 rewrite, working tree before the WP11 fixer) classifyReason for DEFERRED_* /
  // FAILED_* / STALE states, verbatim in behaviour. Never edit it to make V2 pass.
  const has = (r, ...subs) => subs.some((x) => r.includes(x));
  const OLD_RULES = [
    { test: (r) => /newer-live|NEWER_LIVE/i.test(r) || has(r, "evidence-not-newer-than-live", "evidence-not-newer-than-served", "served-newer-to"), cls: CLASSES.SUPERSEDED_NEWER_LIVE, alert: null },
    { test: (r) => has(r, "evidence-instant-not-advanced"), cls: CLASSES.DEPENDENCY, alert: (r, s, ctx) => (ctx.routeId === "fba-plan" ? null : "evidence-instant-not-advanced") },
    { test: (r) => /-integrity(:|$)/.test(r) || has(r, "publish-guard:guard-missing", "publish-guard:guard-mismatch", "portfolio-scope-id-too-long"), cls: CLASSES.INTEGRITY, alert: (r) => (has(r, "publish-guard:") ? "publish-guard-defect" : has(r, "portfolio-scope-id-too-long") ? "portfolio-scope-id-too-long" : "integrity") },
    { test: (r) => has(r, "capacity-exceeded"), cls: CLASSES.CAPACITY_EXCEEDED, alert: "capacity-exceeded" },
    { test: (r) => has(r, "served-row-preempted"), cls: CLASSES.SERVED_ROW_PREEMPTED, alert: (r, s, ctx) => (has(r, "serve-rederives") && ctx.skuMovementServeAttested !== true ? "serve-not-attested" : "served-row-preempted") },
    { test: (r) => has(r, "epoch-not-current-d1"), cls: (r, s, ctx) => (ctx.argAsOf && ctx.expectedAsOf && ctx.argAsOf === ctx.expectedAsOf ? CLASSES.EVIDENCE_ADVANCED : CLASSES.CONFIG_ALERT), alert: (r, s, ctx) => (ctx.argAsOf && ctx.expectedAsOf && ctx.argAsOf === ctx.expectedAsOf ? null : "as-of-not-utc-d1") },
    { test: (r) => has(r, "inventory-guard:served-unreadable", "inventory-guard:live-unreadable", "awd-regression-guard:served-unreadable", "inventory-guard:paid-lineage-unreadable", "inventory-guard:fetch-unordered", "inventory-guard:awd-fetch-unordered"), cls: CLASSES.TRANSPORT, alert: "guard-unreadable" },
    { test: (r) => has(r, "paid-job-raced-insert"), cls: CLASSES.TRANSPORT, alert: "paid-job-raced-insert" },
    { test: (r) => has(r, "publish-guard-threw"), cls: CLASSES.TRANSPORT, alert: "publish-guard-threw" },
    { test: (r) => has(r, "paid-job-stale-in-flight"), cls: CLASSES.DEPENDENCY, alert: "paid-job-stale-in-flight" },
    { test: (r) => has(r, "paid-job-in-flight"), cls: CLASSES.DEPENDENCY, alert: null },
    { test: (r) => has(r, "evidence-advanced", "membership-evidence-advanced", "ads-rows-window-mismatch", "publish-guard:lineage-advanced", "lineage-advanced", "revision-advanced", "manifest-advanced", "asof-rolled", "ads-revision-changed-since-scan", "evidence-inconsistent", "already-current-lost", "source-revision-changed"), cls: CLASSES.EVIDENCE_ADVANCED, alert: null },
    { test: (r) => has(r, "fence-not-attested", "route-not-activated"), cls: CLASSES.ROUTE_NOT_ACTIVATED, alert: "route-not-activated" },
    { test: (r) => has(r, "brand-not-sold"), cls: CLASSES.NOT_APPLICABLE, alert: null },
    { test: (r) => has(r, "storage-missing", "brand-list-invalid", "brand-target-unrepresentable", "member-directory-ambiguous", "pan-eu-ambiguous", "brand-directory-invalid"), cls: CLASSES.MISSING_EVIDENCE, alert: (r) => (has(r, "storage-missing") ? "storage-missing" : "evidence-ambiguous-or-invalid") },
    { test: (r) => has(r, "returns-evidence-missing", "catalog-missing", "oli-coverage-short", "directory-country-missing", "directory-region-unassigned", "no-sales-snapshot", "brand-source-out-of-line", "membership-read-failed", "catalog-empty", "serve-token-underivable", "coverage-incomplete", "no-marketplace", "brand-directory-out-of-line", "ads-rows-evidence-missing", "brand-directory-evidence-missing", "brand-view-evidence-missing") || /(^|:)awd-regression-guard$/.test(r), cls: CLASSES.MISSING_EVIDENCE, alert: null },
    { test: (r) => has(r, "latest-row-ambiguous"), cls: CLASSES.DEPENDENCY, alert: "latest-row-ambiguous" },
    { test: (r) => has(r, "portfolio-build-failed"), cls: CLASSES.DEPENDENCY, alert: "portfolio-build-failed" },
    { test: (r) => r === TARGETS_UNITS_EMPTY, cls: CLASSES.DEPENDENCY, alert: "units-empty" },
    { test: (r) => has(r, "member-setting-up", "brand-directory-unpublished", "brand-sales-candidate"), cls: CLASSES.DEPENDENCY, alert: null },
    { test: (r) => has(r, "hydrate-failed", "evidence-read-failed", "served-read-failed", "evidence-unreadable"), cls: CLASSES.TRANSPORT, alert: null },
  ];
  const oldDeferral = (r) => (/^controls-(not-opened|unresolved|open-threw|apply-error)|CONTROL_LEASE|lease-lost|leaseLost|control-apply|CONTROL_PLANE|^claim-held/i.test(r) ? CLASSES.CONTENTION : /^deadline-cleanup-reserved/i.test(r) ? CLASSES.NOT_ATTEMPTED : /^deadline|^out-of-time|^aborted/i.test(r) ? CLASSES.TIMEOUT : /^cycle-not-running/i.test(r) ? CLASSES.TERMINAL_CYCLE : null);
  const oldFailure = (st, r) => (/^cycle-not-running/i.test(r) ? CLASSES.TERMINAL_CYCLE : /malformed|conflict|integrity|dangling|mismatch|invalid|payload-unreadable|not-d1|corrupt/i.test(r) ? CLASSES.INTEGRITY : (st === STATES.FAILED_READBACK || /readback/i.test(r)) ? CLASSES.READBACK_MISMATCH : /threw|timeout|ETIMEDOUT|ECONN|EAI_AGAIN|fetch|network|socket|5\d\d|429|failed|error/i.test(r) ? CLASSES.TRANSPORT : null);
  const OLD_PROV_RE = /missing|unavailable|^no-|not-d1|incomplete|unresolved|stale|empty|cold|cache-miss|not-yet-saved|before-inventory|not-primary|raw-seller|directory|provenance|evidence|units-invalid|target-asof|oli-window|sales-asof|inventory-asof|marketplace|org-|account-meta|authorization|creates-exceed|tokens-exceed|membership-exceeds|eligible-without-deps|revision-|request-hash|snapshot|catalog|fba-|oli-|ads-|listings|pricing-revision/i;
  // (the imported LEGACY_REASON_CODES only ADDED codes the old pattern already admitted, so the old whitelist is exactly this)
  const oldKnown = (r) => { const code = r.split(":")[0]; return LEGACY_REASON_CODES.has(code) || LEGACY_REASON_CODES.has(code.replace(/^(bundle-|derive-not-ready-)/, "")) || OLD_PROV_RE.test(r); };
  const OLD = (st, r, ctx) => {
    if (st === STATES.STALE) return { cls: CLASSES.STALE, alert: r.endsWith("source-stale-manual") ? "source-stale-manual" : null };
    for (const rule of OLD_RULES) if (rule.test(r)) return { cls: typeof rule.cls === "function" ? rule.cls(r, st, ctx) : rule.cls, alert: (typeof rule.alert === "function" ? rule.alert(r, st, ctx) : rule.alert) || null };
    if (st === STATES.DEPENDENCY) { const c = oldDeferral(r); return c ? { cls: c, alert: null } : { cls: CLASSES.DEPENDENCY, alert: r && oldKnown(r) ? null : "unmapped-reason:" + (r.slice(0, 80) || "blank") }; }
    if (st === STATES.PROVENANCE) { const c = oldDeferral(r); return c ? { cls: c, alert: null } : { cls: CLASSES.MISSING_EVIDENCE, alert: r && oldKnown(r) ? null : "unmapped-reason:" + (r.slice(0, 80) || "blank") }; }
    const f = oldFailure(st, r);
    return f ? { cls: f, alert: f === CLASSES.INTEGRITY || f === CLASSES.TERMINAL_CYCLE ? f : null } : { cls: CLASSES.UNKNOWN, alert: "unmapped-reason:" + (r.slice(0, 80) || st) };
  };
  // ---- the legacy families' code literals (the four reconcilers, their releases and the shared core) ----
  const LEGACY_FILES = [
    "lib/server/sync/oli-publication-reconciler.js", "lib/server/sync/ads-publication-reconciler.js", "lib/server/sync/fba-publication-reconciler.js",
    "lib/server/sync/listing-health-v3-reconciler.js", "lib/server/sync/daily-reporting-release.js", "lib/server/sync/fba-brand-inventory-release.js",
    "lib/server/sync/listing-health-v3-release.js", "lib/server/sync/source-priority-release-runner.js", "lib/server/sync/saved-data-reconciler.js",
    "lib/server/sync/publication-binding.js", "lib/server/sync/source-priority-control-package.js",
  ];
  const codes = new Set([...literalsOf(LEGACY_FILES).keys(), ...LEGACY_REASON_CODES, "oli-provenance-missing", "no-oli", "catalog-stale", "publish-newer-live", "shadow-newer-live", "brand-sales-candidate-to-mismatch", "order-line-items:coverage-incomplete", "campaign-performance-v1:ads-coverage-incomplete", "derive:count-mismatch", "derive:saved-zero"]);
  for (const c of [...codes]) if (!c.includes(":")) codes.add(c + ":detail");
  const states = [STATES.PROVENANCE, STATES.DEPENDENCY, STATES.FAILED_DERIVE, STATES.FAILED_PUBLISH, STATES.FAILED_READBACK, STATES.STALE];
  const diffs = [];
  let compared = 0;
  for (const routeId of LEGACY_ROUTE_IDS) {
    const ctx = { routeId, routeKind: "legacy-cli" };
    // 'derive-not-ready:<sub>' is the ONE intentional change (asserted separately below; no legacy family emits it).
    for (const r of [...codes].filter((x) => !x.startsWith("derive-not-ready:"))) for (const st of states) {
      const n = classifyReason(st, r, ctx); const o = OLD(st, r, ctx); compared += 1;
      if (n.cls !== o.cls || (n.alert || null) !== (o.alert || null)) diffs.push([routeId, st, r, o.cls + "/" + o.alert, n.cls + "/" + n.alert]);
    }
  }
  ok(`V2: the 4 legacy families' verdicts (class AND alert) are IDENTICAL to the pre-fix classifier over ${codes.size} codes x ${states.length} states x ${LEGACY_ROUTE_IDS.length} routes (${compared} comparisons: every legacy module literal, LEGACY_REASON_CODES, ':detail' variants)` + (diffs.length ? " -- DIFFS: " + J([...new Set(diffs.map((d) => d[2] + "@" + d[1] + ":" + d[3] + "->" + d[4]))].slice(0, 400)) : ""), diffs.length === 0 && compared > 4 * 6 * 300);
  // The TWO intentional legacy-path changes (neither is emitted by a legacy module literal, so V2 above is unaffected):
  // (1) a 'derive-not-ready:<sub>' is no longer blanket-whitelisted; (2) a writer-fence refusal ('REPORT_WRITER_FENCED')
  // is INTEGRITY + alert 'writer-fenced' (the WP14 first rule) instead of the pre-fix classification.
  const dnr = classifyReason(STATES.DEPENDENCY, "derive-not-ready:zz-sub", { routeKind: "legacy-cli" });
  ok("V2: intentional legacy-path change 1 is the 'derive-not-ready:<sub>' blanket (never emitted by a legacy family) -- now an unmapped alert; the class is unchanged", dnr.cls === CLASSES.DEPENDENCY && /^unmapped-reason:/.test(S(dnr.alert)) && OLD(STATES.DEPENDENCY, "derive-not-ready:zz-sub", {}).alert === null && ![...literalsOf(LEGACY_FILES).keys()].some((x) => x.startsWith("derive-not-ready:")));
  const wf = classifyReason(STATES.FAILED_PUBLISH, "REPORT_WRITER_FENCED:brand-sales", { routeKind: "legacy-cli" });
  ok("V2: intentional legacy-path change 2 is the writer-fence refusal ('REPORT_WRITER_FENCED', never a legacy module literal) -- INTEGRITY + alert 'writer-fenced'", wf.cls === CLASSES.INTEGRITY && wf.alert === "writer-fenced" && ![...literalsOf(LEGACY_FILES).keys()].some((x) => /REPORT_WRITER_FENCED/.test(x)));
}

/* V3. the explicit NOT_ACTIVATED STOP list against the CLIs' real STOP codes */
{
  const stops = new Map();
  for (const f of ALLOWED_WORKER_SCRIPTS) {
    for (const m of src(f).matchAll(/STOP ([A-Z][A-Z0-9_]{1,63})\b/g)) { if (!stops.has(m[1])) stops.set(m[1], new Set()); stops.get(m[1]).add(path.basename(f)); }
  }
  const gateLike = [...stops.keys()].filter((c) => /ATTEST|NOT_ACTIVATED|FENCE_NOT|ACTIVATION/i.test(c));
  // The ONE explicit non-failure STOP besides the (empty) activation list: the directory-cache scope race (WP11 verifier F2)
  // -> a dependency deferral (no attempt) + alert; it must be a STOP the route CLI really emits.
  const scopeRace = [...SCOPE_RACE_STOP_CODES];
  ok(`V3: the five allowed worker CLIs emit ${stops.size} literal STOP codes; NONE looks like an activation gate unless listed in NOT_ACTIVATED_STOP_CODES (today: none); the ONLY other non-failure STOP is the listed scope race (${scopeRace.join(",")}: a dependency deferral + alert, emitted by the route CLI) -- every other STOP is a run failure + alert` + (gateLike.length ? " -- UNLISTED GATE-LIKE STOP: " + gateLike.join(",") : ""),
    stops.size >= 20 && gateLike.every((c) => NOT_ACTIVATED_STOP_CODES.has(c)) && [...stops.keys()].every((c) => NOT_ACTIVATED_STOP_CODES.has(c) || SCOPE_RACE_STOP_CODES.has(c) || classifyRun({ stop: { code: c }, exitCode: 2 }).cls === CLASSES.RUN_FAILED)
    && J(scopeRace) === J(["ROUTE_TARGET_OUT_OF_SCOPE"]) && scopeRace.every((c) => stops.has(c) && stops.get(c).has("publication-route-reconcile.mjs") && classifyRun({ stop: { code: c }, exitCode: 2 }).cls === CLASSES.DEPENDENCY && classifyRun({ stop: { code: c }, exitCode: 2 }).alert === "route-target-out-of-scope"));
  ok("V3: the route CLI's dynamic parse-refusal STOP ('STOP ' + parsed.code) is the ROUTE_CLI_* argv family (none an activation gate)", /console\.error\("STOP " \+ parsed\.code/.test(src("scripts/release/publication-route-reconcile.mjs")) && ["ROUTE_CLI_ARG", "ROUTE_CLI_LIVE_RUN_TOKEN", "ROUTE_CLI_TARGETS"].every((c) => classifyRun({ stop: { code: c } }).cls === CLASSES.RUN_FAILED));
}

/* V4. every vocabulary entry is well-formed and typed in the states it arrives in */
{
  const ENTRY_RE = /^[a-z][A-Za-z0-9]*(?:[-_.:][A-Za-z0-9]*)*$/;
  const bad = [...ROUTE_REASON_VOCABULARY].filter((e) => !ENTRY_RE.test(e) || e.length > 120);
  ok(`V4: all ${ROUTE_REASON_VOCABULARY.size} vocabulary entries are well-formed machine codes (a ':'-terminated entry is a dynamic-tail prefix); the release wrappers are 'bundle-' and 'derive-not-ready:'`, bad.length === 0 && ROUTE_REASON_VOCABULARY.size > 250 && J(ROUTE_REASON_WRAPPERS) === J(["bundle-", "derive-not-ready:"]));
  const RC = { routeKind: "route-cli" };
  const unmapped = [];
  for (const e of ROUTE_REASON_VOCABULARY) {
    const r = e.endsWith(":") ? e + "x" : e;
    for (const st of [STATES.PROVENANCE, STATES.DEPENDENCY, STATES.FAILED_DERIVE]) {
      const v = classifyReason(st, r, RC);
      if (/^unmapped-reason:/.test(S(v.alert)) || v.cls === CLASSES.UNKNOWN) unmapped.push(st + ":" + r);
    }
    // ... and under each release wrapper (a revision / bundle / derive reason arrives wrapped).
    for (const w of ROUTE_REASON_WRAPPERS) { const v = classifyReason(STATES.DEPENDENCY, w + r, RC); if (/^unmapped-reason:/.test(S(v.alert))) unmapped.push("wrapped:" + w + r); }
  }
  ok("V4: every vocabulary code classifies WITHOUT an unmapped alert in DEFERRED_PROVENANCE / DEFERRED_DEPENDENCY / FAILED_DERIVE and under each release wrapper (never unclassified)" + (unmapped.length ? " -- UNMAPPED: " + unmapped.slice(0, 10).join(" | ") : ""), unmapped.length === 0);
  ok("V4: a reason merely CONTAINING a vocabulary code as a prefix without the ':' boundary is NOT typed (no blanket prefixes)", !routeVocabularyMatch("payload-too-largeX") && !routeVocabularyMatch("claim-heldY") && routeVocabularyMatch("bundle-evidence-missing") && routeVocabularyMatch("derive-not-ready:no-sales-snapshot") && !routeVocabularyMatch("bundle-") && !routeVocabularyMatch(""));
}

writeSync(1, `recovery-classify-vocabulary: ${passed} passed\n`);
