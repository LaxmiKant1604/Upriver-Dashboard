// TRUSTED operator switch for the daily Returns (FBA & FBM) event source (DESIGN-v2 4.2): the ONE durable on/off the
// scheduler-v2 returns_source job reads (source_controls['returns']: schedule_enabled + paused) and the two owner-approved
// per-account handbacks of the event-source state (DESIGN-v2 1.11 / 1.11b). EVERY mode is a DRY RUN (prints current ->
// target, zero writes) unless --apply is passed; every write is read back and verified.
//   node scripts/release/returns-schedule-switch.mjs --enable [--unpause] [--apply]
//       schedule_enabled=true. REFUSED while paused=true unless --unpause (which clears the pause in the SAME write):
//       turning the paid daily schedule on is an owner-approved step, and a pause is never lifted implicitly.
//   node scripts/release/returns-schedule-switch.mjs --disable [--keep-unpaused] [--apply]
//       schedule_enabled=false AND paused=true -- the Tier-1 rollback: the next regional run SKIPs with zero creates and
//       the pause also stops every operator paid path. --keep-unpaused leaves paused untouched. No data changes, nothing
//       is redeployed.
//   node scripts/release/returns-schedule-switch.mjs --release-hold=<accountId> [--apply]
//       release_returns_identity_hold for ONE primary account, after the owner reviewed its identity evidence: clears
//       hold_reason, identity_status='clear', initial_status='pending' -> the next scheduled run re-does the 60-day initial
//       load and re-checks identity. REFUSED when the account holds no hold (a needless reset would buy a paid reload),
//       and REFUSED (RETURNS_CONFIRM_PENDING) while its last_status is 'replaced': a replace still awaits its
//       post-commit confirm, which must judge the load it wrote (the next run's zero-token re-verify settles it) --
//       the RPC refuses the same way.
//   node scripts/release/returns-schedule-switch.mjs --release-fence=<accountId> [--apply]
//       release_returns_legacy_fence for ONE primary account (owner-approved handback to the legacy Returns writer):
//       legacy_fence=false, initial_status='pending', its 'returns' coverage removed. REFUSED when no fence is set, and
//       REFUSED while the schedule is ON (or its control row is unreadable): the handback is a Tier-1 rollback step only --
//       an enabled schedule would re-own the account on its next run with a fresh paid 60-day initial load.
// Exactly ONE action per invocation; any duplicate / unknown / malformed argument is a usage STOP (exit 2) BEFORE
// loadReleaseEnv() and before any I/O. The release modes use the PRIMARY organization fingerprint (the same
// primaryOrganizationFingerprint() the admin source endpoints use) and the region the account's stored marketplace routes
// to (scheduler-scope.regionForCountry -- the ONE marketplace->region definition). It writes ONLY through the reviewed
// wrappers (setSourceControl for the one 'returns' row; releaseReturnsIdentityHold / releaseReturnsLegacyFence for one
// account) and never touches another source, another account, events, history, Settlements or a publication.
// OUTPUT CONTRACT (public repo): statuses, typed codes, counts and an 8-char account prefix ONLY -- never a secret, the
// organization fingerprint, a full account / seller id or a raw error body.
// Exit: 0 done or dry run | 1 refused / unreadable / write or read-back failed | 2 usage. 7-bit ASCII, LF.

import { loadReleaseEnv } from "./env-bootstrap.mjs";

// ---- PURE helpers (no imports, no I/O, no env, no process access) -- scripts/returns-source-workflow.test.js evaluates
// ---- this block in a vm sandbox, so it must stay self-contained.
const RETURNS_CONTROL_KEY = "returns";
const RETURNS_REGIONS = ["india", "europe-au", "us-ca"];
const RELEASE_RPC = { "release-hold": "release_returns_identity_hold", "release-fence": "release_returns_legacy_fence" };
const RELEASE_WRAPPER = { "release-hold": "releaseReturnsIdentityHold", "release-fence": "releaseReturnsLegacyFence" };
const IDENTITY_COUNT_KEYS = ["keyedFba", "keyedFbm", "unkeyed", "keyCollisions", "cogsVariants", "identicalUnkeyed"];
const USAGE = "usage: returns-schedule-switch.mjs --enable [--unpause] [--apply] | --disable [--keep-unpaused] [--apply] | --release-hold=<accountId> [--apply] | --release-fence=<accountId> [--apply]";
const mask8 = (v) => String(v == null ? "" : v).slice(0, 8);
// A DB value printed in the output: a typed token or a placeholder (never an arbitrary value).
const safeToken = (v) => (v == null || v === "" ? "none" : (/^[A-Za-z0-9_.:-]{1,64}$/.test(String(v)) ? String(v) : "?"));
const safeTime = (v) => (v == null || v === "" ? "none" : (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}(:?\d{2})?)?$/.test(String(v)) ? String(v) : "?"));
const boolToken = (v) => (v === true ? "true" : v === false ? "false" : "?");

/** argv (process.argv.slice(2)) -> { ok:true, action, apply, unpause, keepUnpaused, accountId } | { ok:false, message }. */
function parseSwitchArgv(argv) {
  const ACCOUNT_RE = /^[A-Za-z0-9._-]{1,128}$/;
  const out = { ok: true, action: null, apply: false, unpause: false, keepUnpaused: false, accountId: null };
  const actions = []; const seen = new Set();
  const list = Array.isArray(argv) ? argv.map((a) => String(a)) : [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const eq = a.indexOf("=");
    const name = eq < 0 ? a : a.slice(0, eq);
    // Never echo an argument that could carry an id: only a well-formed flag NAME is printed, else its position.
    const label = /^--[a-z][a-z-]{0,39}$/.test(name) ? name : "#" + (i + 1);
    if (seen.has(name)) return { ok: false, message: "duplicate argument " + label };
    seen.add(name);
    if (eq < 0 && (a === "--enable" || a === "--disable")) { actions.push(a.slice(2)); continue; }
    if (eq < 0 && a === "--apply") { out.apply = true; continue; }
    if (eq < 0 && a === "--unpause") { out.unpause = true; continue; }
    if (eq < 0 && a === "--keep-unpaused") { out.keepUnpaused = true; continue; }
    if (eq > 0 && (name === "--release-hold" || name === "--release-fence")) {
      const id = a.slice(eq + 1);
      if (!ACCOUNT_RE.test(id)) return { ok: false, message: name + "=<accountId> must be ONE primary account id (^[A-Za-z0-9._-]{1,128}$; no dd-secondary prefix, no list)" };
      actions.push(name.slice(2)); out.accountId = id; continue;
    }
    return { ok: false, message: "unknown argument " + label };
  }
  if (actions.length !== 1) return { ok: false, message: "pass exactly ONE action: --enable | --disable | --release-hold=<accountId> | --release-fence=<accountId>" };
  out.action = actions[0];
  if (out.unpause && out.action !== "enable") return { ok: false, message: "--unpause is accepted ONLY with --enable" };
  if (out.keepUnpaused && out.action !== "disable") return { ok: false, message: "--keep-unpaused is accepted ONLY with --disable" };
  if (out.action === "enable" || out.action === "disable") out.accountId = null;
  return out;
}

/** The source_controls['returns'] write for --enable / --disable, or a typed refusal. `before` = the CURRENT row. */
function controlTarget(before, args) {
  if (args.action === "enable") {
    if (before && before.paused === true && !args.unpause) {
      return { refused: "RETURNS_SWITCH_PAUSED", message: "source_controls['returns'] is paused; --enable refuses while paused (pass --unpause to clear the pause in the same write -- an owner decision)" };
    }
    return { refused: null, write: args.unpause ? { scheduleEnabled: true, paused: false } : { scheduleEnabled: true } };
  }
  if (args.action === "disable") return { refused: null, write: args.keepUnpaused ? { scheduleEnabled: false } : { scheduleEnabled: false, paused: true } };
  return { refused: "RETURNS_SWITCH_ACTION", message: "not a schedule action" };
}

/** The read-back proof of a control write: schedule_enabled (and paused, when written) equal the target. */
function controlVerified(after, write) {
  return !!after && !!write && after.schedule_enabled === write.scheduleEnabled && (write.paused === undefined || after.paused === write.paused);
}

const describeWrite = (w) => "schedule_enabled=" + w.scheduleEnabled + (w.paused === undefined ? " (paused untouched)" : " paused=" + w.paused);

/** A typed refusal for a release, or null when the release may proceed. `state` = the account's state row | null. */
function releaseRefusal(state, action, region) {
  if (!RELEASE_RPC[action]) return { code: "RETURNS_SWITCH_ACTION", message: "not a release action" };
  if (!state) return { code: "RETURNS_STATE_ROW_MISSING", message: "the account has no source_returns_account_state row (nothing to release)" };
  if (action === "release-hold" && (state.hold_reason == null || String(state.hold_reason).trim() === "")) {
    return { code: "RETURNS_NO_HOLD", message: "the account holds no identity hold (a release would only reset it to a paid 60-day reload)" };
  }
  if (action === "release-hold" && state.last_status === "replaced") {
    return { code: "RETURNS_CONFIRM_PENDING", message: "a replace still awaits its post-commit confirm (last_status 'replaced'); the next run's zero-token re-verify settles it -- release after that" };
  }
  if (action === "release-fence" && state.legacy_fence !== true) {
    return { code: "RETURNS_FENCE_NOT_SET", message: "the account's legacy-writer fence is not set (already handed back)" };
  }
  if (!RETURNS_REGIONS.includes(String(region))) {
    return { code: "RETURNS_REGION_UNRESOLVED", message: "the account's stored marketplace routes to no active region" };
  }
  return null;
}

/** The read-back proof of a release (the RPC's documented post-state). */
function releaseVerified(after, action) {
  if (!after) return false;
  if (action === "release-hold") return (after.hold_reason == null || String(after.hold_reason) === "") && after.identity_status === "clear" && after.initial_status === "pending";
  if (action === "release-fence") return after.legacy_fence === false && after.initial_status === "pending";
  return false;
}

/** One state row as a safe one-line summary (typed statuses + identity COUNTS only). */
function stateSummary(s) {
  if (!s) return "state=absent";
  const det = s.identity_detail && typeof s.identity_detail === "object" && !Array.isArray(s.identity_detail) ? s.identity_detail : {};
  const counts = IDENTITY_COUNT_KEYS.filter((k) => Number.isInteger(det[k]) && det[k] >= 0).map((k) => k + "=" + det[k]).join(",");
  return "marketplace=" + safeToken(s.marketplace_country_code) + " initial_status=" + safeToken(s.initial_status)
    + " identity_status=" + safeToken(s.identity_status) + " hold_reason=" + safeToken(s.hold_reason)
    + " legacy_fence=" + boolToken(s.legacy_fence)
    + " last_status=" + safeToken(s.last_status) + " last_error_code=" + safeToken(s.last_error_code)
    + (counts ? " identity_counts{" + counts + "}" : "");
}
// ---- END PURE helpers ----

const parsed = parseSwitchArgv(process.argv.slice(2));
if (!parsed.ok) { console.error("STOP RETURNS_SWITCH_USAGE: " + parsed.message + "\n" + USAGE); process.exit(2); }

loadReleaseEnv(); // portable: loads <repoRoot>/.env.local when present, maps SUPABASE_URL, never overrides CI env

const log = (m) => console.log("returns-schedule: " + m);
const stop = (code, message) => { console.error("STOP " + code + ": " + message); process.exit(1); };
// A thrown wrapper error, reduced to its TYPED fields only (CONTRACT D: .returnsCode / .code / .status) -- never .message.
const typedError = (e) => [e && e.returnsCode, e && e.code, e && e.status].filter((x) => x != null && /^[A-Za-z0-9_.-]{1,64}$/.test(String(x))).join("/") || "untyped";

// NAMED imports only (never the module namespace as a value): the writer-fence analysis (scripts/report-writer-fence.test.js)
// then proves this script reaches exactly these five wrappers -- source_controls + the two account handbacks -- and no
// report_snapshots sink.
const { getSourceControls, setSourceControl, getReturnsAccountStates, releaseReturnsIdentityHold, releaseReturnsLegacyFence } = await import("../../lib/server/supabase.js");

const readControl = async () => {
  let r = null;
  try { r = await getSourceControls(); } catch (e) { return stop("RETURNS_CONTROLS_UNREADABLE", "source_controls read threw (" + typedError(e) + ")"); }
  if (!r || r.read !== "ok") return stop("RETURNS_CONTROLS_UNREADABLE", "source_controls unreadable (" + safeToken(r && r.read) + ")");
  const row = (r.rows || []).find((x) => x && x.source_key === RETURNS_CONTROL_KEY);
  if (!row) return stop("RETURNS_CONTROL_ROW_MISSING", "no source_controls row for '" + RETURNS_CONTROL_KEY + "' (seeded by migration 20260820; never created here)");
  return row;
};
const controlLine = (row) => "schedule_enabled=" + boolToken(row.schedule_enabled) + " paused=" + boolToken(row.paused) + " updated_at=" + safeTime(row.updated_at);

if (parsed.action === "enable" || parsed.action === "disable") {
  const before = await readControl();
  log("BEFORE " + controlLine(before));
  const plan = controlTarget(before, parsed);
  if (plan.refused) stop(plan.refused, plan.message);
  log("TARGET " + describeWrite(plan.write) + (parsed.apply ? "" : " (DRY RUN -- zero writes; re-run with --apply)"));
  if (!parsed.apply) process.exit(0);
  // updated_by is the browser-admin uuid FK (auth.users) -- a service-role operator never writes it (see
  // scheduled-source-controls.mjs); the operator identity is this run's log.
  try { await setSourceControl({ sourceKey: RETURNS_CONTROL_KEY, ...plan.write }); } catch (e) { stop("RETURNS_SWITCH_WRITE_FAILED", "setSourceControl failed (" + typedError(e) + "); re-run to read the current state"); }
  const after = await readControl();
  log("AFTER  " + controlLine(after));
  if (!controlVerified(after, plan.write)) stop("RETURNS_SWITCH_READBACK_MISMATCH", "the read-back does not show " + describeWrite(plan.write));
  log("COMMITTED " + describeWrite(plan.write) + (parsed.action === "disable" ? " -- the next regional returns_source run SKIPs with zero creates" : " -- the next regional returns_source run refreshes within its per-region cap"));
  process.exit(0);
}

// ---- --release-hold / --release-fence (ONE primary account) ----
const { primaryOrganizationFingerprint } = await import("../../lib/server/datadoe-connections.js");
const { regionForCountry } = await import("../../lib/server/sync/scheduler-scope.js");
const orgFp = primaryOrganizationFingerprint();
if (!orgFp) stop("RETURNS_NO_PRIMARY_CONNECTION", "the primary DataDoe connection is not configured (fail closed)");
const wrapper = RELEASE_WRAPPER[parsed.action];
const releaseFn = parsed.action === "release-hold" ? releaseReturnsIdentityHold : releaseReturnsLegacyFence;
if (typeof getReturnsAccountStates !== "function" || typeof releaseFn !== "function") {
  stop("RETURNS_WRAPPER_MISSING", "lib/server/supabase.js lacks getReturnsAccountStates / " + wrapper + " (the event-source code is not deployed in this tree)");
}
const accountLabel = "account " + mask8(parsed.accountId);
const readState = async () => {
  let r = null;
  try { r = await getReturnsAccountStates({ organizationFingerprint: orgFp, connectionId: "primary", accountIds: [parsed.accountId] }); } catch (e) { return stop("RETURNS_STATE_UNREADABLE", "state read threw (" + typedError(e) + ")"); }
  if (!r || r.read !== "ok") return stop("RETURNS_STATE_UNREADABLE", "source_returns_account_state read=" + safeToken(r && r.read) + " ('missing' = migration 20260942 is not applied)");
  const rows = (r.rows || []).filter((x) => x && x.account_id === parsed.accountId && (x.connection_id == null || x.connection_id === "primary"));
  if (rows.length > 1) return stop("RETURNS_STATE_AMBIGUOUS", accountLabel + " has " + rows.length + " primary state rows (fail closed)");
  return rows[0] || null;
};

const before = await readState();
const region = before ? regionForCountry(before.marketplace_country_code) : "";
log(accountLabel + " BEFORE " + stateSummary(before) + " region=" + safeToken(region));
const refusal = releaseRefusal(before, parsed.action, region);
if (refusal) stop(refusal.code, accountLabel + ": " + refusal.message + " -- zero writes");
const expected = parsed.action === "release-hold"
  ? "hold_reason=none identity_status=clear initial_status=pending (the next run re-does the 60-day initial load + identity check)"
  : "legacy_fence=false initial_status=pending, the account's 'returns' coverage removed (legacy writer owns it again)";
log("TARGET " + RELEASE_RPC[parsed.action] + " -> " + expected + (parsed.apply ? "" : " (DRY RUN -- zero writes; re-run with --apply)"));
// The schedule state decides whether a handback can hold. A legacy handback (--release-fence) is a Tier-1 rollback step
// ONLY: while the schedule is ON the next regional run would re-own the account with a fresh PAID 60-day initial load and
// set the fence again, so it is REFUSED (an unreadable control row refuses too -- fail closed). --release-hold is meant
// to re-run the initial load, so for it the state is only reported.
let scheduleOn = null;
try {
  const c = await getSourceControls();
  const row = c && c.read === "ok" ? (c.rows || []).find((x) => x && x.source_key === RETURNS_CONTROL_KEY) : null;
  scheduleOn = row ? row.schedule_enabled === true && row.paused !== true : null;
} catch (_e) { scheduleOn = null; }
if (parsed.action === "release-fence" && scheduleOn !== false) {
  stop(scheduleOn === null ? "RETURNS_CONTROLS_UNREADABLE" : "RETURNS_SCHEDULE_ON",
    accountLabel + ": " + (scheduleOn === null ? "source_controls['returns'] is unreadable" : "the returns schedule is ON")
      + " -- a legacy handback is a Tier-1 rollback step only (run --disable --apply first) -- zero writes");
}
if (parsed.action === "release-hold" && scheduleOn === true) log("NOTE the schedule is ON: the next " + safeToken(region) + " returns_source run starts this account with a fresh paid 60-day initial load");
if (!parsed.apply) process.exit(0);

const runKey = "returns-schedule-switch:" + parsed.action + ":" + new Date().toISOString();
try {
  await releaseFn({ organizationFingerprint: orgFp, connectionId: "primary", accountId: parsed.accountId, runKey, region });
} catch (e) {
  stop("RETURNS_RELEASE_FAILED", RELEASE_RPC[parsed.action] + " refused (" + typedError(e) + ") -- re-run without --apply to read the current state");
}
const after = await readState();
log(accountLabel + " AFTER  " + stateSummary(after));
if (!releaseVerified(after, parsed.action)) stop("RETURNS_RELEASE_READBACK_MISMATCH", accountLabel + ": the read-back does not show " + expected);
log("COMMITTED " + RELEASE_RPC[parsed.action] + " for " + accountLabel + " (region " + safeToken(region) + ")");
process.exit(0);
