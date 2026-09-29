// The shared-snapshot IDENTITY hash -- a PURE leaf (imports only node:crypto).
//
// paramsHashFor(reportVersion, params) is the report_snapshots.params_hash every writer stores and every serve reads
// by. It lives here (moved VERBATIM out of report-store.js, which imports + re-exports it, so every existing caller is
// byte-identical) so a READ-ONLY consumer -- the publication recovery WORKER's route modules
// (lib/server/recovery/routes/*.route.js) -- can compute an exact identity WITHOUT statically pulling report-store.js
// and, through it, the supabase.js writers (saveReportSnapshot, claimRefreshLock, ...) into its import graph.
// 7-bit ASCII, LF.

import { createHash } from "node:crypto";

export function paramsHashFor(reportVersion, params) {
  const ordered = {};
  Object.keys(params || {}).sort().forEach((key) => {
    const value = params[key];
    if (value !== undefined && value !== null && value !== "") ordered[key] = String(value);
  });
  return createHash("sha256")
    .update(JSON.stringify({ reportVersion, ...ordered }))
    .digest("hex")
    .slice(0, 40);
}
