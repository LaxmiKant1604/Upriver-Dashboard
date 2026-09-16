// Forgot-password (account recovery) request + completion logic -- PURE, anti-enumeration, no I/O of its own.
//
// Extracted so App.jsx's LoginScreen wires to ONE tested source of truth (mirrors src/lib/session-lifecycle.js).
// The official Supabase recovery flow is two legs:
//   1) REQUEST: supabase.auth.resetPasswordForEmail(email, { redirectTo }) -> Supabase emails a recovery link.
//   2) COMPLETE: the link returns to `redirectTo`; detectSessionInUrl fires a PASSWORD_RECOVERY auth event; the
//      existing "Set your password" form calls supabase.auth.updateUser({ password }).
// This module owns the pure decisions of BOTH legs (validation, anti-enumeration, safe error mapping); the React
// component owns only the wiring + state.

// The SINGLE neutral response shown for EVERY completed reset REQUEST (whether or not the account exists, and
// whether Supabase returns success OR an error). This is the anti-enumeration contract: the UI must never branch
// its message on account existence.
export const NEUTRAL_RESET_MESSAGE =
  "If an account exists for that email, a password recovery link has been sent. Check your inbox (and spam folder).";

// The minimum password length, shared by the setup form + its test (kept === App.jsx's existing rule).
export const MIN_PASSWORD_LENGTH = 8;

// Client-side email shape gate ONLY (the server is authoritative). Empty/blank/oversized/malformed -> false. This
// gates an obviously-empty submit; it deliberately does NOT probe existence (that would enable enumeration).
export function isValidRecoveryEmail(email) {
  const e = typeof email === "string" ? email.trim() : "";
  if (e.length === 0 || e.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

// The redirect the recovery email link returns to. MUST be an origin whose app carries the PASSWORD_RECOVERY
// listener + detectSessionInUrl, and MUST be one of Supabase Auth's allowlisted redirect URLs. We use the CURRENT
// deployment origin (window.location.origin) -- in production that is https://upriverdashboard.vercel.app, the
// same origin the working sign-up confirmation (emailRedirectTo) already uses, so it is already allowlisted.
// Returns "" for a missing/blank origin so the caller can omit redirectTo (Supabase then falls back to Site URL).
export function resolveRecoveryRedirect(origin) {
  const o = typeof origin === "string" ? origin.trim() : "";
  // Only ever return an absolute http(s) origin -- never a relative/path value that could redirect off-app.
  return /^https?:\/\/[^\s]+$/.test(o) ? o : "";
}

// REQUEST a password-recovery email. ANTI-ENUMERATION: returns the SAME neutral outcome for a known OR unknown
// account, and whether Supabase resolves OR rejects -- the caller shows `message` (NEUTRAL_RESET_MESSAGE) in every
// completed case. Only two NON-enumerating client conditions are surfaced distinctly: the client not being
// configured, and an obviously-invalid email. NEVER logs the email, tokens, or passwords. NEVER throws.
export async function requestPasswordReset({ supabase, email, redirectTo } = {}) {
  const reset = supabase && supabase.auth && supabase.auth.resetPasswordForEmail;
  if (typeof reset !== "function") {
    return { ok: false, sent: false, code: "unavailable", message: "Password recovery is unavailable right now. Please try again later." };
  }
  if (!isValidRecoveryEmail(email)) {
    return { ok: false, sent: false, code: "invalid-email", message: "Enter the email address for your account." };
  }
  const target = String(email).trim();
  const options = {};
  const redirect = resolveRecoveryRedirect(redirectTo);
  if (redirect) options.redirectTo = redirect;
  try {
    // We deliberately IGNORE the returned { error }: a Supabase error for a non-existent email (or a rate limit,
    // or a transient network fault) must never change what the user sees -- otherwise the differing response would
    // leak whether the account exists. No part of the email/token is read back or logged.
    await reset.call(supabase.auth, target, options);
  } catch {
    // Swallowed for the SAME reason -- a thrown rejection can never reveal account state. Nothing is logged.
  }
  return { ok: true, sent: true, code: "sent", message: NEUTRAL_RESET_MESSAGE };
}

// Validate a NEW password chosen on the recovery/invite completion form. Pure; returns { valid, message }.
// (Kept byte-identical in rule to App.jsx's existing setup form: length >= MIN_PASSWORD_LENGTH + confirm match.)
export function validateNewPassword(password, confirmPassword) {
  const p = typeof password === "string" ? password : "";
  if (p.length < MIN_PASSWORD_LENGTH) return { valid: false, message: `Use at least ${MIN_PASSWORD_LENGTH} characters for your password.` };
  if (p !== confirmPassword) return { valid: false, message: "Passwords do not match." };
  return { valid: true, message: "" };
}

// Map a Supabase updateUser() recovery-completion error to a SAFE, non-leaking user message. An expired/invalid
// recovery link (no auth session, or a used/expired token) is the common case -> tell the user to request a new
// link. Any other error is shown generically. Never surfaces raw tokens or internal detail.
export function classifyRecoveryUpdateError(error) {
  const raw = (error && (error.message || error.error_description || error.msg)) ? String(error.message || error.error_description || error.msg) : "";
  const text = raw.toLowerCase();
  const expired = /expired|invalid|not\s*found|missing|no\s*(auth\s*)?session|jwt|token|unauthorized|401|403/.test(text);
  if (expired) {
    return { code: "link-expired", message: "This recovery link has expired or is invalid. Request a new recovery email and try again." };
  }
  return { code: "update-failed", message: "We could not update your password. Please try again." };
}
