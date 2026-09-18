// Shared-report cross-account stale-flash regression.
//
// DEFECT: on an authenticated account switch, the selector changed immediately but useSharedReport kept exposing the
// PREVIOUS account's payload (its `data` state persisted across params changes) for the ~seconds until the new request
// completed -- a cross-account accuracy + isolation presentation defect. The load is async (awaits the browser cache,
// then the network), so nothing hid the old rows synchronously.
//
// FIX (src/lib/shared-report-projection.js): every held payload is TAGGED with the exact params identity (apiCacheKey --
// account + brand + marketplace + date-window + report action + authorization fingerprint) and is exposed ONLY while its
// tag equals the CURRENT identity (projectSharedReport). The load lifecycle is a reducer keyed by a monotonic request
// id so a late response from a superseded identity can never overwrite the current one, and a payload is only ever
// recorded under the identity that produced it.
//
// This suite proves it two ways:
//   A. Behavioural unit tests of the pure decisions + a state-machine simulation of the account-switch sequence.
//   B. Static-source assertions that App.jsx actually wires useSharedReport to those decisions (these FAIL on the old
//      code, which held `data` in a plain useState and setData'd across identities).
//
// 7-bit ASCII, LF, no top-level await.

import assert from "node:assert/strict";
import { readFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  sharedReportInitialState, sharedReportReducer, projectSharedReport,
} from "../src/lib/shared-report-projection.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const app = readFileSync(path.join(root, "src/App.jsx"), "utf8");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); }
writeSync(1, "shared-report-projection\n");

// Identities are opaque strings here; in production they are apiCacheKey(params), which folds account/brand/
// marketplace/window/action AND the authorization fingerprint. `A`/`B` model two accounts; `A_fp2` models the SAME
// account under a DIFFERENT authorization fingerprint (a scope change) -- a distinct identity.
const A = "action=lh&ids=DE-acct&__fp=fp1";
const B = "action=lh&ids=UK-acct&__fp=fp1";
const A_fp2 = "action=lh&ids=DE-acct&__fp=fp2";
const reduce = (state, events) => events.reduce(sharedReportReducer, state);
const project = (currentKey, state, active = true) => projectSharedReport({ currentKey, active, state });

/* ===================== A. pure identity gate ===================== */
(() => {
  // Account A data loaded and visible under A.
  const s = reduce(sharedReportInitialState(), [
    { type: "load-start", myId: 1, key: A },
    { type: "cache-miss", myId: 1, key: A },
    { type: "network", myId: 1, key: A, body: { rows: ["DE-1", "DE-2"] }, cachedAt: 111 },
    { type: "settle", myId: 1 },
  ]);
  const underA = project(A, s);
  ok("A: Account A data is visible under Account A (loading/updating false)",
    underA.data && underA.data.rows[0] === "DE-1" && underA.loading === false && underA.updating === false && underA.error === null && underA.cachedAt === 111);

  // SYNCHRONOUS hide: the SAME state, projected under Account B (the selector switched), exposes NO A data and shows
  // loading -- before any effect or network runs. This is the crux of the fix.
  const underB = project(B, s);
  ok("A: switching the identity to B immediately HIDES A's data (synchronous, pre-network)",
    underB.data === null && underB.cachedAt === null && underB.loading === true && underB.updating === false);
})();

/* ===================== B. loading while B has no matching payload ===================== */
(() => {
  const s = reduce(sharedReportInitialState(), [
    { type: "load-start", myId: 1, key: A },
    { type: "network", myId: 1, key: A, body: { rows: ["DE-1"] }, cachedAt: 1 },
    { type: "settle", myId: 1 },
    // switch to B, no cache for B yet
    { type: "load-start", myId: 2, key: B },
    { type: "cache-miss", myId: 2, key: B },
  ]);
  const p = project(B, s);
  ok("B: while B has no matching payload the view is LOADING with no data (A never shown)", p.data === null && p.loading === true && p.updating === false);
  // An inactive report never shows loading (its view is not mounted).
  ok("B: an INACTIVE report exposes no data and no loading", projectSharedReport({ currentKey: B, active: false, state: s }).loading === false && projectSharedReport({ currentKey: B, active: false, state: s }).data === null);
})();

/* ===================== C. a matching B browser cache may be shown (revalidating) ===================== */
(() => {
  const s = reduce(sharedReportInitialState(), [
    { type: "load-start", myId: 1, key: A },
    { type: "network", myId: 1, key: A, body: { rows: ["DE-1"] }, cachedAt: 1 },
    { type: "settle", myId: 1 },
    { type: "load-start", myId: 2, key: B },
    { type: "cache", myId: 2, key: B, body: { rows: ["UK-cache"] }, cachedAt: 222 },
  ]);
  const p = project(B, s);
  ok("C: a matching Account B browser cache MAY be shown, flagged updating (revalidating), never A",
    p.data && p.data.rows[0] === "UK-cache" && p.updating === true && p.loading === false && p.cachedAt === 222);
})();

/* ===================== D. a late Account A response cannot overwrite Account B ===================== */
(() => {
  let s = reduce(sharedReportInitialState(), [
    { type: "load-start", myId: 1, key: A },
    { type: "network", myId: 1, key: A, body: { rows: ["DE-1"] }, cachedAt: 1 },
    { type: "settle", myId: 1 },
    { type: "load-start", myId: 2, key: B },
    { type: "network", myId: 2, key: B, body: { rows: ["UK-1"] }, cachedAt: 2 },
    { type: "settle", myId: 2 },
  ]);
  // A slow response from the SUPERSEDED A load (myId 1) arrives now -- it must be ignored (reqId is 2).
  s = sharedReportReducer(s, { type: "network", myId: 1, key: A, body: { rows: ["DE-LATE"] }, cachedAt: 9 });
  const p = project(B, s);
  ok("D: a late Account A response (superseded reqId) is IGNORED and never overwrites Account B",
    p.data && p.data.rows[0] === "UK-1" && !s.entry.body.rows.includes("DE-LATE"));
})();

/* ===================== E. B appears ONLY when tagged with B's exact identity ===================== */
(() => {
  // A response that lands under the CURRENT reqId but is mis-tagged with A's identity must NOT surface under B.
  const misTagged = reduce(sharedReportInitialState(), [
    { type: "load-start", myId: 2, key: B },
    { type: "network", myId: 2, key: A, body: { rows: ["DE-mislabeled"] }, cachedAt: 1 },
  ]);
  ok("E: a payload tagged with A's identity is NOT exposed under B (identity, not arrival order, gates display)",
    project(B, misTagged).data === null && project(B, misTagged).loading === true);
  // The correctly-tagged B payload surfaces.
  const tagged = sharedReportReducer(misTagged, { type: "network", myId: 2, key: B, body: { rows: ["UK-1"] }, cachedAt: 2 });
  ok("E: Account B data appears only when tagged with B's exact request identity", project(B, tagged).data.rows[0] === "UK-1" && project(B, tagged).loading === false);
})();

/* ===================== F. same-identity revalidation keeps last-known-good ===================== */
(() => {
  // B loaded from network. A same-identity background revalidation begins (auto-revalidate): the payload MUST stay
  // visible (last-known-good), never blanked, and only same-identity revalidation may do this.
  let s = reduce(sharedReportInitialState(), [
    { type: "load-start", myId: 1, key: B },
    { type: "network", myId: 1, key: B, body: { rows: ["UK-1"] }, cachedAt: 5 },
    { type: "settle", myId: 1 },
  ]);
  s = reduce(s, [
    { type: "load-start", myId: 2, key: B }, // same identity, revalidating
    { type: "cache", myId: 2, key: B, body: { rows: ["UK-1"] }, cachedAt: 5 },
  ]);
  const p = project(B, s);
  ok("F: same-identity revalidation KEEPS the last-known-good payload visible (updating, not blanked)",
    p.data && p.data.rows[0] === "UK-1" && p.loading === false && p.updating === true);
  // A refreshed network result for the same identity replaces it.
  s = sharedReportReducer(s, { type: "network", myId: 2, key: B, body: { rows: ["UK-2"] }, cachedAt: 6 });
  ok("F: the revalidated same-identity result replaces the last-known-good", project(B, s).data.rows[0] === "UK-2" && project(B, s).cachedAt === 6);
})();

/* ===================== G. authorization-generation safeguard: a scope change is a distinct identity ===================== */
(() => {
  // Account A under fingerprint fp1 loaded. The authorization fingerprint advances (fp2) -> the CURRENT identity becomes
  // A_fp2, which does not match the fp1-tagged payload, so it is hidden even though the account id is unchanged.
  const s = reduce(sharedReportInitialState(), [
    { type: "load-start", myId: 1, key: A },
    { type: "network", myId: 1, key: A, body: { rows: ["DE-fp1"] }, cachedAt: 1 },
    { type: "settle", myId: 1 },
  ]);
  ok("G: a payload for A under fp1 is HIDDEN once the authorization fingerprint advances (fp2) -- never reused cross-scope",
    project(A_fp2, s).data === null && project(A_fp2, s).loading === true);
  ok("G: the same payload is still shown under its own unchanged identity (fp1)", project(A, s).data.rows[0] === "DE-fp1");
})();

/* ===================== H. error / clear / paramless ===================== */
(() => {
  const errS = reduce(sharedReportInitialState(), [
    { type: "load-start", myId: 1, key: A },
    { type: "cache-miss", myId: 1, key: A },
    { type: "error", myId: 1, key: A, message: "boom" },
  ]);
  const e = project(A, errS);
  ok("H: an error for the current identity surfaces (no loading, no data)", e.error === "boom" && e.loading === false && e.data === null);
  ok("H: that error does NOT surface under a different identity B", project(B, errS).error === null);
  ok("H: a paramless (null) current identity exposes nothing", project(null, errS).data === null && project(null, errS).loading === false);
  ok("H: 'clear' resets to the initial empty state", JSON.stringify(sharedReportReducer(errS, { type: "clear" })) === JSON.stringify(sharedReportInitialState()));
})();

/* ===================== I. STATIC-SOURCE: App.jsx wires useSharedReport to the identity gate (FAILS on old code) ===================== */
(() => {
  ok("I: App.jsx imports the shared-report projection module", /from "\.\/lib\/shared-report-projection\.js"/.test(app) && /projectSharedReport/.test(app) && /sharedReportReducer/.test(app));
  const hookStart = app.indexOf("function useSharedReport(");
  ok("I: useSharedReport is present", hookStart > -1);
  const hookBody = app.slice(hookStart, hookStart + 5200);
  ok("I: the hook computes the CURRENT identity from apiCacheKey(params)", /const currentKey = params \? apiCacheKey\(params\) : null;/.test(hookBody));
  ok("I: the hook renders through the pure identity gate projectSharedReport({ currentKey, active, state })", /projectSharedReport\(\{ currentKey, active, state \}\)/.test(hookBody));
  ok("I: the hook drives state through the tagged reducer (useReducer(sharedReportReducer))", /useReducer\(sharedReportReducer/.test(hookBody));
  ok("I: every landed payload is TAGGED with the params identity (key: myKey)", /dispatch\(\{ type: "network", myId, key: myKey/.test(hookBody));
  ok("I: the monotonic late-response guard is retained", /if \(myId !== reqId\.current\) return;/.test(hookBody));
  // The OLD defect signature -- a plain persisted `data` state set directly across identities -- must be gone.
  ok("I: the old persisted-data-state hook body is REPLACED (no 'first paint (no cache yet)' useState)", !/const \[loading, setLoading\] = useState\(false\);\s*\/\/ first paint/.test(app) && !/const \[data, setData\] = useState\(null\);/.test(hookBody));
})();

writeSync(1, `\nshared-report-projection: ${passed} assertions passed\n`);
