// RETIRED operator (Listings inventory cutover, 2026-10). This script recovered accounts blocked by a terminal TRUNCATED
// FBA Inventory Health batch by downloading their retained single-seller Health exports and compacting each payload to its
// latest provably-complete date. FBA Inventory Health is RETIRED: no request contract fetches it, the bucket sync and the
// fba-plan operation never plan it, and lib/server/datadoe.js createExport refuses its source id (HEALTH_SOURCE_RETIRED).
// FBA inventory now comes from the canonical Listings export (one shared <=5-seller batch, never split), so there is no
// Health overflow to recover. The script is kept ONLY so an old runbook invocation fails loudly and typed instead of
// silently doing something else: it performs ZERO reads, ZERO writes, ZERO DataDoe calls and exits non-zero.
//
// The last SAVED Health snapshots (public.source_snapshots 'fba-inventory-health') stay in place untouched: they are read
// only as the dated read-only bridge (lib/server/inventory-source.js); nothing here reads or rewrites them. 7-bit ASCII, LF.

console.error("STOP fba-inventory-recovery is RETIRED (HEALTH_SOURCE_RETIRED): FBA Inventory Health is no longer fetched; FBA inventory comes from the canonical Listings export. Nothing was read, written or created.");
process.exit(2);
