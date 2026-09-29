// RETIRED (publication recovery WP13). This was an UNFENCED manual writer of the live 'daily-reporting' report key (it
// re-saved every named-brand Daily Reporting snapshot with a direct saveReportSnapshot outside the four-gate publisher /
// fenced CAS / sync_report_jobs lineage). Daily Reporting is now published ONLY through the fenced publisher: by the
// scheduler's priority publication and by the zero-export publication reconcilers (the recovery worker's 'oli' and
// 'ads' routes), which re-derive it from durable evidence:
//
//   node scripts/release/oli-publication-reconcile.mjs --bucket=<india|europe-au|us-ca> --as-of=YYYY-MM-DD --mode=periodic
//   node scripts/release/ads-publication-reconcile.mjs --bucket=<india|europe-au|us-ca> --as-of=YYYY-MM-DD --mode=periodic
//     (dry-run by default -- a read-only plan, zero writes; --live promotes through the fenced publisher)
//
// This entrypoint REFUSES to run (exit 2) and performs NO I/O: it imports nothing, reads no env file, opens no
// connection and never touches TLS settings. It is listed in the worker's FORBIDDEN_WORKER_SCRIPTS. 7-bit ASCII, LF.

const ROUTE_CLI = "scripts/release/oli-publication-reconcile.mjs";
console.error(
  "STOP DAILY_NAMED_BRANDS_BACKFILL_RETIRED: scripts/release/backfill-daily-named-brands.mjs is retired (an unfenced writer of the live daily-reporting key). "
  + "Publish Daily Reporting ONLY through the fenced zero-export routes: node " + ROUTE_CLI
  + " --bucket=<india|europe-au|us-ca> --as-of=YYYY-MM-DD --mode=periodic (and scripts/release/ads-publication-reconcile.mjs for the Ads band; dry-run by default; --live promotes through the fenced publisher). Zero writes, zero DataDoe.",
);
process.exit(2);
