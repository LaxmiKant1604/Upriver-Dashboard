// Session / account-directory stability regressions.
//
// The authenticated shell used to be replaced by a full-page bootstrap screen
// ("Loading your Amazon accounts...") every time the tab regained focus or
// Supabase refreshed the access token, because the App root:
//   1. keyed its access-loading effect on the access TOKEN (a TOKEN_REFRESHED
//      re-ran it, nulled access, and unmounted the whole DashboardApp), and
//   2. rebuilt a fresh `access` object on every focus/visibility revalidation,
//      whose new array references cascaded the account-directory effect back into
//      its full-page loading state.
//
// This suite proves the corrected lifecycle two ways:
//   A. Behavioural unit tests of the pure decisions in src/lib/session-lifecycle.js
//      (the single source of truth App.jsx wires to), incl. a state-machine
//      simulation of the App root over a token-refresh / focus / grant-change /
//      sign-out sequence, and read-request coalescing.
//   B. Static-source assertions that App.jsx actually wires to those decisions
//      (effect keyed on the user id, cold-only full-page bootstrap, silent
//      same-scope revalidation, coalesced reads). These FAIL on the old code.
//
// 7-bit ASCII, LF, no top-level await.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  accessFingerprintClient, accessScopeChanged, accessReloadKey, authEventClearsAccess,
  isColdAccountState, projectAuthorizedAccounts, createInFlightCoalescer,
} from "../src/lib/session-lifecycle.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const app = readFileSync(path.join(root, "src/App.jsx"), "utf8");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); }
async function okAsync(name, run) { assert.ok(await run(), name); passed += 1; writeSync(1, `  ok ${name}\n`); }

writeSync(1, "session-stability\n");

/* ============================ A. behavioural ============================ */

// A grant set and a byte-identical copy (a token refresh returns the same scope).
const accessA = { userId: "u1", role: "member", accountGrants: { acc1: { mode: "ALL_BRANDS" }, acc2: { mode: "BRAND_SCOPED", brandKeys: ["b", "a"] } } };
const accessAcopy = { userId: "u1", role: "member", accountGrants: { acc2: { mode: "BRAND_SCOPED", brandKeys: ["a", "b"] }, acc1: { mode: "ALL_BRANDS" } } };
const accessNarrowed = { userId: "u1", role: "member", accountGrants: { acc1: { mode: "ALL_BRANDS" } } }; // acc2 revoked
const accessOtherUser = { userId: "u2", role: "member", accountGrants: { acc1: { mode: "ALL_BRANDS" } } };

ok("fingerprint is stable across key order / brand-key order (a refresh is silent)",
  accessFingerprintClient(accessA) === accessFingerprintClient(accessAcopy));
ok("fingerprint changes when a grant is revoked", accessFingerprintClient(accessA) !== accessFingerprintClient(accessNarrowed));
ok("fingerprint changes when the user changes", accessFingerprintClient(accessA) !== accessFingerprintClient(accessOtherUser));

ok("accessScopeChanged: identical scope is NOT applied (silent revalidation)",
  accessScopeChanged(accessFingerprintClient(accessA), accessFingerprintClient(accessAcopy)) === false);
ok("accessScopeChanged: first (cold) load always applies", accessScopeChanged(null, accessFingerprintClient(accessA)) === true);
ok("accessScopeChanged: a scope narrowing applies (purge + re-resolve)",
  accessScopeChanged(accessFingerprintClient(accessA), accessFingerprintClient(accessNarrowed)) === true);

ok("accessReloadKey is the stable user id (unchanged by a token refresh)",
  accessReloadKey({ user: { id: "u1" }, access_token: "t1" }) === "u1" &&
  accessReloadKey({ user: { id: "u1" }, access_token: "t2-refreshed" }) === "u1");
ok("accessReloadKey changes for a different user", accessReloadKey({ user: { id: "u2" } }) === "u2");
ok("accessReloadKey is null with no session", accessReloadKey(null) === null);

ok("authEventClearsAccess: only SIGNED_OUT clears", authEventClearsAccess("SIGNED_OUT") === true);
["TOKEN_REFRESHED", "SIGNED_IN", "USER_UPDATED", "INITIAL_SESSION", "PASSWORD_RECOVERY"].forEach((e) => {
  ok(`authEventClearsAccess: ${e} does NOT clear access`, authEventClearsAccess(e) === false);
});

ok("isColdAccountState: true only with zero accounts", isColdAccountState(0) === true && isColdAccountState(3) === false);

// projectAuthorizedAccounts: instant narrowing without waiting for the refetch.
const dir = [{ id: "acc1" }, { id: "acc2" }, { id: "acc3" }];
const allowed = new Set(["acc1", "acc3"]);
ok("projectAuthorizedAccounts drops now-unauthorized accounts for non-admins",
  JSON.stringify(projectAuthorizedAccounts(dir, allowed, false)) === JSON.stringify([{ id: "acc1" }, { id: "acc3" }]));
ok("projectAuthorizedAccounts returns the SAME reference when nothing was removed (no needless re-render)",
  projectAuthorizedAccounts(dir, new Set(["acc1", "acc2", "acc3"]), false) === dir);
ok("projectAuthorizedAccounts never restricts an admin", projectAuthorizedAccounts(dir, new Set(), true) === dir);

// State-machine simulation of the App root over a realistic event sequence.
// The ONLY full-page bootstrap allowed is the initial cold load; nothing after it
// (token refresh, focus, grant change) may blank the app.
function simulateAppRoot() {
  const state = {
    userId: null, accessFp: null, accessApplied: false,
    accounts: [{ id: "acc1" }, { id: "acc2" }],
    fullPageBlanks: 0, dashboardMounts: 0, accessReloads: 0,
  };
  const renderFullPage = (accountsShown) => { if (isColdAccountState(accountsShown)) state.fullPageBlanks += 1; };
  // Model the user-id-keyed access effect: it only runs (and cold-boots) when the reload key changes.
  const authEvent = (event, session, fetchedAccess) => {
    if (authEventClearsAccess(event)) { state.accessApplied = false; state.accessFp = null; state.userId = null; return; }
    const key = accessReloadKey(session);
    if (key !== state.userId) {
      // identity change / first load: cold bootstrap (access nulled, then loaded)
      state.userId = key; state.accessApplied = false; state.accessFp = null; state.dashboardMounts += 1;
      renderFullPage(0); // cold access screen counts as a bootstrap
    }
    // (revalidation of access happens via `revalidate`, below)
    state.accessReloads += 1;
    const fp = accessFingerprintClient(fetchedAccess);
    if (accessScopeChanged(state.accessFp, fp)) { state.accessFp = fp; state.accessApplied = true; }
  };
  return { state, authEvent };
}

await okAsync("token refresh + repeated focus never blank the app (accounts + access retained)", () => {
  const { state, authEvent } = simulateAppRoot();
  authEvent("INITIAL_SESSION", { user: { id: "u1" }, access_token: "t1" }, accessA); // cold boot (1 mount)
  const mountsAfterBoot = state.dashboardMounts;
  const blanksAfterBoot = state.fullPageBlanks;
  authEvent("TOKEN_REFRESHED", { user: { id: "u1" }, access_token: "t2" }, accessAcopy); // silent
  authEvent("SIGNED_IN", { user: { id: "u1" }, access_token: "t3" }, accessAcopy); // focus recovery, silent
  authEvent("TOKEN_REFRESHED", { user: { id: "u1" }, access_token: "t4" }, accessAcopy); // silent
  return state.dashboardMounts === mountsAfterBoot // no remount after the cold boot
    && state.fullPageBlanks === blanksAfterBoot     // no new full-page blank
    && state.accessApplied === true                 // access still present
    && state.accounts.length === 2;                 // accounts retained
});

await okAsync("a mid-session grant change re-resolves WITHOUT a full-page blank", () => {
  const { state, authEvent } = simulateAppRoot();
  authEvent("INITIAL_SESSION", { user: { id: "u1" }, access_token: "t1" }, accessA);
  const blanksAfterBoot = state.fullPageBlanks;
  // admin narrows grants: fingerprint changes -> applied (purge), but accounts already exist -> no blank
  state.accounts = projectAuthorizedAccounts(state.accounts, new Set(["acc1"]), false);
  authEvent("USER_UPDATED", { user: { id: "u1" }, access_token: "t1" }, accessNarrowed);
  return state.fullPageBlanks === blanksAfterBoot && state.accessFp === accessFingerprintClient(accessNarrowed)
    && state.accounts.length === 1;
});

await okAsync("a different user signing in cold-boots (does NOT reuse the prior scope)", () => {
  const { state, authEvent } = simulateAppRoot();
  authEvent("INITIAL_SESSION", { user: { id: "u1" }, access_token: "t1" }, accessA);
  const mountsAfterU1 = state.dashboardMounts;
  authEvent("SIGNED_IN", { user: { id: "u2" }, access_token: "z1" }, accessOtherUser);
  return state.dashboardMounts === mountsAfterU1 + 1 && state.accessFp === accessFingerprintClient(accessOtherUser);
});

// Read-request coalescing: N concurrent identical reads => ONE underlying call.
await okAsync("createInFlightCoalescer dedups concurrent identical reads", async () => {
  const c = createInFlightCoalescer();
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const make = () => c.run("owner:acc1", async () => { calls += 1; await gate; return calls; });
  const p1 = make(); const p2 = make(); const p3 = make();
  release();
  const [a, b, d] = await Promise.all([p1, p2, p3]);
  return calls === 1 && a === 1 && b === 1 && d === 1;
});

await okAsync("createInFlightCoalescer runs a fresh call once the prior settled (and clears)", async () => {
  const c = createInFlightCoalescer();
  let calls = 0;
  await c.run("k", async () => { calls += 1; });
  await c.run("k", async () => { calls += 1; });
  return calls === 2 && c.size === 0;
});

await okAsync("createInFlightCoalescer does not cache rejections", async () => {
  const c = createInFlightCoalescer();
  let calls = 0;
  await c.run("k", async () => { calls += 1; throw new Error("boom"); }).catch(() => {});
  await c.run("k", async () => { calls += 1; }).catch(() => {});
  return calls === 2 && c.size === 0;
});

/* ========================= B. static App.jsx wiring ===================== */

ok("App.jsx imports the session-lifecycle decisions", /from "\.\/lib\/session-lifecycle\.js"/.test(app));
["accessFingerprintClient", "accessScopeChanged", "authEventClearsAccess", "isColdAccountState", "createInFlightCoalescer", "projectAuthorizedAccounts"].forEach((name) => {
  ok(`App.jsx wires to ${name}`, app.includes(name));
});

// The access-loading effect must key on the STABLE user id, never the access token.
// (A regex tolerant of whitespace; the OLD, broken dependency must be gone.)
ok("access effect is keyed on the user id (not the access token)", /\},\s*\[session\?\.user\?\.id\]\);/.test(app));
ok("access effect is NOT keyed on the access token", !/\},\s*\[session\?\.access_token\]\);/.test(app));

// Only a real sign-out clears access; a token refresh must not.
ok("onAuthStateChange clears access only via authEventClearsAccess", /if \(authEventClearsAccess\(event\)\)/.test(app));

// Silent same-scope revalidation: access is applied only when the scope changed.
ok("revalidated access is applied only when accessScopeChanged", /accessScopeChanged\(/.test(app));

// Cold-only full-page bootstrap for the account directory.
const accountLoadingIdx = app.indexOf("Loading your Amazon accounts");
ok("the 'Loading your Amazon accounts' guard exists", accountLoadingIdx >= 0);
const guardWindow = app.slice(Math.max(0, accountLoadingIdx - 220), accountLoadingIdx);
ok("account-loading full page is gated by the cold state (isColdAccountState)", /isColdAccountState\(accounts\.length\)/.test(guardWindow));
ok("account-loading full page is no longer a bare `if (accountsLoading)`", !/if \(accountsLoading\) \{\s*$/.test(guardWindow.split("\n").slice(-3).join("\n")));

// Account-directory reads are coalesced through the shared read layer, keyed by the captured (fingerprint-scoped) key.
ok("loadSharedReport coalesces concurrent reads keyed by the captured cache key",
  /createInFlightCoalescer\(\)/.test(app)
  && /async function loadSharedReport[\s\S]{0,800}const key = apiCacheKey\(params\)[\s\S]{0,300}sharedReadCoalescer\.run\(key,/.test(app));

writeSync(1, `\nsession-stability: ${passed} assertions passed\n`);
