// RETIRED (publication recovery WP13). This was an UNFENCED manual writer of the live 'brand-sales' report key (a direct
// saveReportSnapshot outside the four-gate publisher / fenced CAS / sync_report_jobs lineage). Brand Sales is now
// published ONLY through the fenced publisher: by the scheduler's priority publication and by the zero-export OLI
// publication reconciler (the recovery worker's 'oli' route), which re-derives brand-sales from durable OLI evidence:
//
//   node scripts/release/oli-publication-reconcile.mjs --bucket=<india|europe-au|us-ca> --as-of=YYYY-MM-DD --mode=periodic
//     (dry-run by default -- a read-only plan, zero writes; --live promotes through the fenced publisher)
//
// This entrypoint REFUSES to run (exit 2) and performs NO I/O: it imports nothing, reads no env file, opens no
// connection and never touches TLS settings. It is listed in the worker's FORBIDDEN_WORKER_SCRIPTS. 7-bit ASCII, LF.

const ROUTE_CLI = "scripts/release/oli-publication-reconcile.mjs";
console.error(
  "STOP BRAND_SALES_BACKFILL_RETIRED: scripts/release/backfill-brand-sales.mjs is retired (an unfenced writer of the live brand-sales key). "
  + "Publish Brand Sales ONLY through the fenced zero-export route: node " + ROUTE_CLI
  + " --bucket=<india|europe-au|us-ca> --as-of=YYYY-MM-DD --mode=periodic (dry-run by default; --live promotes through the fenced publisher). Zero writes, zero DataDoe.",
);
process.exit(2);
