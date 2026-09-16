// Forgot-password (account recovery) flow -- behavioural unit tests of the PURE src/lib/password-recovery.js
// decisions + static-source assertions that App.jsx's LoginScreen wires to them and preserves the existing auth
// behaviour (sign-in / sign-up / PASSWORD_RECOVERY -> updateUser). The security contract under test:
//   - anti-enumeration: a KNOWN and an UNKNOWN email yield the IDENTICAL neutral outcome;
//   - never reveals existence via an error/throw/rate-limit (all swallowed to the same neutral message);
//   - never logs the email, tokens, or passwords;
//   - a real production redirect origin is passed through;
//   - the recovery-completion (updateUser) validation + safe expired-link mapping;
//   - existing sign-in/sign-up/recovery-event behaviour is unchanged.
// Offline; zero network. 7-bit ASCII, LF, no top-level await.

import assert from "node:assert/strict";
import { readFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  NEUTRAL_RESET_MESSAGE, MIN_PASSWORD_LENGTH, isValidRecoveryEmail, resolveRecoveryRedirect,
  requestPasswordReset, validateNewPassword, classifyRecoveryUpdateError,
} from "../src/lib/password-recovery.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const app = readFileSync(path.join(root, "src/App.jsx"), "utf8");
const lib = readFileSync(path.join(root, "src/lib/password-recovery.js"), "utf8");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); }
async function okAsync(name, run) { assert.ok(await run(), name); passed += 1; writeSync(1, `  ok ${name}\n`); }

writeSync(1, "password-recovery\n");

// A spy Supabase whose resetPasswordForEmail records its call and returns a scripted result (resolve/throw).
function makeSupabase(behaviour) {
  const calls = [];
  return {
    calls,
    supabase: {
      auth: {
        resetPasswordForEmail: async (email, options) => {
          calls.push({ email, options });
          if (behaviour === "throw") throw new Error("network down for user@known.example");
          if (behaviour === "error-unknown") return { data: {}, error: { message: "User not found" } };
          return { data: {}, error: null };
        },
      },
    },
  };
}

const PROD = "https://upriverdashboard.vercel.app";

/* ============================ A. behavioural: request leg ============================ */

await okAsync("A: a valid request calls resetPasswordForEmail with the trimmed email + production redirectTo", async () => {
  const s = makeSupabase("ok");
  const r = await requestPasswordReset({ supabase: s.supabase, email: "  user@known.example  ", redirectTo: PROD });
  return r.ok === true && r.sent === true && r.message === NEUTRAL_RESET_MESSAGE
    && s.calls.length === 1 && s.calls[0].email === "user@known.example" && s.calls[0].options.redirectTo === PROD;
});

await okAsync("A: NO USER ENUMERATION -- a known email and an unknown email produce the IDENTICAL neutral outcome", async () => {
  const known = await requestPasswordReset({ supabase: makeSupabase("ok").supabase, email: "user@known.example", redirectTo: PROD });
  const unknownResolved = await requestPasswordReset({ supabase: makeSupabase("error-unknown").supabase, email: "nobody@nowhere.example", redirectTo: PROD });
  const unknownThrew = await requestPasswordReset({ supabase: makeSupabase("throw").supabase, email: "nobody@nowhere.example", redirectTo: PROD });
  return JSON.stringify(known) === JSON.stringify(unknownResolved) && JSON.stringify(known) === JSON.stringify(unknownThrew);
});

await okAsync("A: a Supabase ERROR result is swallowed -> still the neutral 'sent' outcome (no existence leak)", async () => {
  const r = await requestPasswordReset({ supabase: makeSupabase("error-unknown").supabase, email: "x@y.example", redirectTo: PROD });
  return r.ok === true && r.sent === true && r.code === "sent" && r.message === NEUTRAL_RESET_MESSAGE;
});

await okAsync("A: a THROWN Supabase rejection is swallowed -> still the neutral 'sent' outcome (never throws)", async () => {
  let threw = false; let r = null;
  try { r = await requestPasswordReset({ supabase: makeSupabase("throw").supabase, email: "x@y.example", redirectTo: PROD }); } catch { threw = true; }
  return threw === false && r && r.ok === true && r.sent === true;
});

await okAsync("A: an invalid/blank email is surfaced (client-side) and NEVER calls resetPasswordForEmail (no probe)", async () => {
  const s = makeSupabase("ok");
  const blank = await requestPasswordReset({ supabase: s.supabase, email: "   ", redirectTo: PROD });
  const bad = await requestPasswordReset({ supabase: s.supabase, email: "not-an-email", redirectTo: PROD });
  return blank.ok === false && blank.code === "invalid-email" && bad.ok === false && bad.code === "invalid-email" && s.calls.length === 0;
});

await okAsync("A: an unconfigured client -> typed 'unavailable' (never throws, never enumerates)", async () => {
  const r = await requestPasswordReset({ supabase: null, email: "x@y.example", redirectTo: PROD });
  return r.ok === false && r.code === "unavailable";
});

await okAsync("A: NO PASSWORD/TOKEN LOGGING -- requestPasswordReset writes nothing to any console channel", async () => {
  const channels = ["log", "info", "warn", "error", "debug"];
  const saved = {}; const captured = [];
  for (const c of channels) { saved[c] = console[c]; console[c] = (...args) => captured.push(args.join(" ")); }
  try {
    await requestPasswordReset({ supabase: makeSupabase("throw").supabase, email: "secret.user@known.example", redirectTo: PROD });
    await requestPasswordReset({ supabase: makeSupabase("error-unknown").supabase, email: "secret.user@known.example", redirectTo: PROD });
  } finally { for (const c of channels) console[c] = saved[c]; }
  const joined = captured.join(" | ");
  return captured.length === 0 && !joined.includes("secret.user@known.example");
});

/* ============================ A. behavioural: redirect + validation ============================ */

ok("A: resolveRecoveryRedirect keeps an absolute https origin, drops blank/relative/non-http (no off-app redirect)",
  resolveRecoveryRedirect(PROD) === PROD
  && resolveRecoveryRedirect("http://localhost:5173") === "http://localhost:5173"
  && resolveRecoveryRedirect("") === "" && resolveRecoveryRedirect("/reset") === "" && resolveRecoveryRedirect("javascript:alert(1)") === "");

await okAsync("A: with no resolvable redirect origin, redirectTo is OMITTED (Supabase falls back to Site URL)", async () => {
  const s = makeSupabase("ok");
  await requestPasswordReset({ supabase: s.supabase, email: "x@y.example", redirectTo: "" });
  return s.calls.length === 1 && !("redirectTo" in s.calls[0].options);
});

ok("A: isValidRecoveryEmail accepts a normal address, rejects blank/spaces/no-domain/oversized",
  isValidRecoveryEmail("a@b.co") && !isValidRecoveryEmail("") && !isValidRecoveryEmail("   ")
  && !isValidRecoveryEmail("a@b") && !isValidRecoveryEmail("nope") && !isValidRecoveryEmail("x".repeat(250) + "@b.co"));

ok("A: validateNewPassword enforces the shared minimum length + confirm match",
  validateNewPassword("short", "short").valid === false
  && validateNewPassword("longenough", "different").valid === false
  && validateNewPassword("longenough", "longenough").valid === true
  && MIN_PASSWORD_LENGTH === 8);

ok("A: classifyRecoveryUpdateError maps an expired/invalid link to a safe 'request a new one' message",
  classifyRecoveryUpdateError({ message: "Auth session missing!" }).code === "link-expired"
  && classifyRecoveryUpdateError({ message: "Email link is invalid or has expired" }).code === "link-expired"
  && classifyRecoveryUpdateError({ message: "token has expired" }).code === "link-expired"
  && classifyRecoveryUpdateError({ message: "database write failed" }).code === "update-failed");

ok("A: the recovery module SOURCE contains no console.* call (defence-in-depth against token/email logging)",
  !/\bconsole\s*\./.test(lib));

/* ============================ B. static wiring: App.jsx LoginScreen ============================ */

ok("B: App.jsx imports the recovery helpers from ./lib/password-recovery.js",
  /import\s*\{[^}]*requestPasswordReset[^}]*\}\s*from\s*"\.\/lib\/password-recovery\.js"/.test(app));

ok("B: LoginScreen has a forgotMode state and a visible 'Forgot password?' action",
  /const\s*\[\s*forgotMode\s*,\s*setForgotMode\s*\]\s*=\s*useState\(false\)/.test(app)
  && /Forgot password\?/.test(app) && /setForgotMode\(true\)/.test(app));

ok("B: the forgot branch calls requestPasswordReset with the current origin resolved via resolveRecoveryRedirect",
  /if\s*\(\s*forgotMode\s*\)/.test(app) && /requestPasswordReset\(\s*\{/.test(app)
  && /resolveRecoveryRedirect\(\s*typeof window[^)]*window\.location\.origin/.test(app));

ok("B: double submission is prevented (busy guard before the async work)",
  /if\s*\(\s*busy\s*\)\s*return;/.test(app));

ok("B: EXISTING behaviour preserved -- signInWithPassword + signUp remain",
  /supabase\.auth\.signInWithPassword\(/.test(app) && /supabase\.auth\.signUp\(/.test(app));

ok("B: EXISTING recovery event preserved -- PASSWORD_RECOVERY still drives the set-password form",
  /event\s*===\s*"PASSWORD_RECOVERY"/.test(app) && /setPasswordSetup\(true\)/.test(app));

ok("B: password-set completion uses updateUser({ password }) guarded by validateNewPassword + safe error mapping",
  /supabase\.auth\.updateUser\(\s*\{\s*password\s*\}\s*\)/.test(app)
  && /validateNewPassword\(\s*password\s*,\s*confirmPassword\s*\)/.test(app)
  && /classifyRecoveryUpdateError\(/.test(app));

writeSync(1, `\npassword-recovery: ${passed} assertions passed\n`);
