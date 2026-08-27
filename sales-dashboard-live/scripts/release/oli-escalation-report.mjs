// ADMIN-ONLY, REDACTED DataDoe escalation evidence for a provisional / source-defect D-1 run. Assembles the durable
// evidence needed to escalate an itemization gap or a genuine source-data defect to DataDoe WITHOUT exposing any
// secret or customer identifier: source id, account PREFIXES (first 6 chars), marketplace bucket, the requested
// window, per-account itemized-vs-pending order/unit counts, itemization %, the completeness status, the genuine
// defect count, and the source EXPORT-ID PREFIXES that produced the evidence. Prints redacted aggregates only.
//
// Usage (from sales-dashboard-live/, read-only, zero tokens):
//   node scripts/release/oli-escalation-report.mjs --bucket=us|non-us [--requested-as-of=YYYY-MM-DD]

import pg from "pg";
import { loadReleaseEnv } from "./env-bootstrap.mjs";
loadReleaseEnv();

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const bucket = argOf("bucket");
if (bucket !== "us" && bucket !== "non-us") { console.error("STOP --bucket must be us|non-us"); process.exit(2); }
const requestedAsOf = argOf("requested-as-of") || argOf("as-of") || (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedAsOf)) { console.error("STOP --requested-as-of must be YYYY-MM-DD"); process.exit(2); }

const { getDataDoeConnections, classifyDirectoryAccounts } = await import("../../lib/server/datadoe-connections.js");
const { fetchAccounts } = await import("../../lib/server/datadoe.js");
const { bucketForCountry } = await import("../../lib/server/sync/registry.js");
const { organizationFingerprint } = await import("../../lib/server/source-identity.js");
const { OLI_SOURCE_ID } = await import("../../lib/server/sync/registry.js").catch(() => ({ OLI_SOURCE_ID: "89b27535d2" }));

const primary = getDataDoeConnections().find((c) => c.id === "primary");
const orgFp = primary.organizationFingerprint || organizationFingerprint(primary.apiKey);
const rows = (await fetchAccounts(primary.apiKey)) || [];
const { active } = classifyDirectoryAccounts(rows, getDataDoeConnections());
const seen = new Set(); const ids = [];
for (const a of active) { const id = String((a && (a.accountId ?? a.id)) || "").trim(); const co = String((a && a.country) || "").toUpperCase(); if (!id || id.includes(":") || seen.has(id) || bucketForCountry(co) !== bucket) continue; seen.add(id); ids.push(id); }

const base = String(process.env.POSTGRES_URL).split("?")[0];
const c = new pg.Client({ connectionString: base, ssl: { rejectUnauthorized: false } });
await c.connect();
const comp = (await c.query(
  "select account_id, completeness_status, itemized_order_count, pending_order_count, itemized_unit_count, pending_unit_count, defect_count, itemization_percent, source_export_ids, refreshed_at from public.source_oli_completeness where sale_date=$1 and account_id = any($2::text[]) order by completeness_status, itemization_percent",
  [requestedAsOf, ids],
)).rows;
await c.end();

const redactId = (s) => { const v = String(s || "").trim(); return v ? v.slice(0, 6) + "…" : "(none)"; };
const redactExport = (arr) => (Array.isArray(arr) ? arr : []).map((e) => redactId(e));
const perStatus = { provisional: 0, final: 0, "source-defect": 0 };
let itemized = 0, pending = 0, pendingUnits = 0, defects = 0;
const accounts = [];
for (const r of comp) {
  perStatus[r.completeness_status] = (perStatus[r.completeness_status] || 0) + 1;
  itemized += Number(r.itemized_order_count) || 0; pending += Number(r.pending_order_count) || 0;
  pendingUnits += Number(r.pending_unit_count) || 0; defects += Number(r.defect_count) || 0;
  accounts.push({
    account: redactId(r.account_id), status: r.completeness_status,
    itemizedOrders: Number(r.itemized_order_count) || 0, pendingOrders: Number(r.pending_order_count) || 0,
    pendingUnits: Number(r.pending_unit_count) || 0, defectRows: Number(r.defect_count) || 0,
    itemizationPercent: Number(r.itemization_percent) || 0, exportIds: redactExport(r.source_export_ids),
    refreshedAt: r.refreshed_at,
  });
}
const totOrders = itemized + pending;
const report = {
  generatedForBucket: bucket, requestedAsOf, sourceId: OLI_SOURCE_ID || "89b27535d2", sourceName: "Order Line Items",
  organizationFingerprintPrefix: redactId(orgFp),
  accountsWithEvidence: comp.length, ofDiscovered: ids.length,
  byStatus: perStatus,
  totals: { itemizedOrders: itemized, pendingOrders: pending, pendingUnits, genuineDefectRows: defects, itemizationPercent: totOrders > 0 ? Math.round((itemized / totOrders) * 1000) / 10 : 100 },
  note: defects > 0
    ? "GENUINE SOURCE DEFECT: itemized recognized-sale rows with a null item_price_value -- escalate these accounts to DataDoe (real-time source should carry the value)."
    : "Expected pending itemization: D-1 orders exist but item_status/item_price_value are not yet populated for some orders (Amazon item-level lag). Published PROVISIONAL; promotes to FINAL automatically as itemization completes.",
  accounts,
};
console.log(JSON.stringify(report, null, 2));
process.exit(0);
