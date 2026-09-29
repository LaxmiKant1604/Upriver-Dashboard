// RETIRED (publication recovery WP6). This was an UNFENCED manual writer of the live 'sku-movement' report key (a direct
// saveReportSnapshot outside the four-gate publisher / fenced CAS / sync_report_jobs lineage). SKU Movement is now
// published ONLY by the zero-export 'sku-movement' recovery route through the fenced publisher:
//
//   node scripts/release/publication-route-reconcile.mjs --route=sku-movement --bucket=<india|europe-au|us-ca> --as-of=YYYY-MM-DD [--targets=<accountIds>]
//     (dry-run by default; a live run needs --live --targets=<accountIds> --run-token=<token>, or --mode=scheduler)
//
// This entrypoint REFUSES to run (exit 2) and performs NO I/O: it imports nothing, reads no env file, opens no
// connection and never touches TLS settings. It is listed in the worker's FORBIDDEN_WORKER_SCRIPTS (WP11). 7-bit ASCII, LF.

const ROUTE_CLI = "scripts/release/publication-route-reconcile.mjs --route=sku-movement";
console.error(
  "STOP SKU_MOVEMENT_BACKFILL_RETIRED: scripts/release/backfill-sku-movement.mjs is retired (an unfenced writer of the live sku-movement key). "
  + "Publish SKU Movement ONLY through the fenced zero-export route: node " + ROUTE_CLI
  + " --bucket=<india|europe-au|us-ca> --as-of=YYYY-MM-DD [--targets=<accountIds>] (dry-run by default; --live needs --targets + --run-token). Zero writes, zero DataDoe.",
);
process.exit(2);
