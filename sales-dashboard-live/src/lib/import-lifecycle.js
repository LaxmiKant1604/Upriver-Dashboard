// Identity + note semantics for the FBA lead-time import lifecycle (file-select -> async parse -> preview ->
// confirm -> POST -> reload) and for account-keyed configuration state. PURE, offline-testable, no React.
//
// Why: a preview parsed for account A (validated against A's ASIN catalog + diffed against A's saved values) must
// NEVER be applied to account B, and a per-account config load must never render A's saved values under B. These
// helpers make the identity binding explicit so both App.jsx and its tests share ONE definition.

// The immutable scope of one import lifecycle: the account + the session token. A change to EITHER (account switch,
// sign-out, token rotation to a different user) is a different scope and invalidates a pending parse/preview.
export function importScopeKey(accountId, token) {
  return `${accountId == null ? "" : String(accountId)}::${token == null ? "" : String(token)}`;
}

// The note to PERSIST for a lead-time write. An OMITTED note (undefined/null -- an inline day edit or a Start/Reset
// that does not touch the note) PRESERVES the current saved note. An EXPLICITLY supplied note (any string, including
// "" that the user actually approved) is used verbatim, so blank-as-clear stays intentional. Omission never clears.
export function resolveLeadTimeNote(suppliedNote, currentNote) {
  if (suppliedNote === undefined || suppliedNote === null) return currentNote == null ? "" : String(currentNote);
  return String(suppliedNote);
}

// May a pending preview be applied to the CURRENT live scope? Rechecked immediately before the POST so an account /
// session change between preview and Apply cancels the import (nothing is retargeted). Returns { ok, reason }.
export function canApplyImport(previewScope, liveAccountId, liveToken) {
  if (!previewScope) return { ok: false, reason: "no-preview" };
  if (previewScope !== importScopeKey(liveAccountId, liveToken)) return { ok: false, reason: "scope-changed" };
  return { ok: true, reason: null };
}

// Tag a freshly-loaded config with the account it belongs to (so the UI can prove which account it is showing).
export function tagConfigAccount(cfg, accountId) {
  const base = cfg && typeof cfg === "object" ? cfg : { settings: null, overrides: [], warehouse: [] };
  return { ...base, __accountId: accountId == null ? null : String(accountId) };
}

// Account-keyed config selection: expose the config ONLY when it belongs to `accountId`; otherwise null (i.e. the
// current account's config is not yet loaded -> show a loading state + disable config-dependent actions, never A's
// data under B). A read failure is represented by a null config + a separate error flag by the caller.
export function configForAccount(planConfig, accountId) {
  if (planConfig && planConfig.__accountId === (accountId == null ? null : String(accountId))) return planConfig;
  return null;
}

// Is the current account's configuration loaded and belongs to it (ready for config-dependent actions)?
export function isConfigReady(planConfig, accountId) {
  return !!configForAccount(planConfig, accountId);
}
