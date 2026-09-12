// Pure build-time feature-flag predicate. A Vite `VITE_*` variable is a STRING at build time (or `undefined` when
// unset); Vite inlines it into the browser bundle. This returns true ONLY for the exact string "true" -- absent
// (undefined), blank (""), "false", "FALSE", "1", "yes", " true " (whitespace) or any other malformed value is OFF.
// Kept deliberately PURE -- it reads no Vite build metadata -- so it is import-safe + exhaustively unit-testable in
// Node (the browser flag module that consumes it is NOT Node-importable). 7-bit ASCII, LF.
export function envFlagOn(value) {
  return value === "true";
}
