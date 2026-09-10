// TRUSTED, READ-ONLY production-schema capability preflight for the HEALTHY-SUBSET (priority-partial) publication.
// Usage (run from sales-dashboard-live/, in the scheduler BEFORE opening any publication control, ONLY on a PARTIAL):
//   node scripts/release/priority-partial-preflight.mjs --bucket=india|europe-au|us-ca
//
// It proves the production schema can OPEN a `priority-partial-<region>-<16hex>` cycle -- i.e. the approval-gated
// migration 20260924 has widened BOTH the EXACT `public.open_sync_cycle(text, date, timestamptz, text)` guard AND the
// `public.sync_cycles_bucket_check` constraint to contain the exact priority-partial regex (verified via the SHARED
// readPartialCycleCapability; NOT "any pg_proc whose text mentions priority-partial"). Exit 0 = permitted (the workflow
// may open controls + publish the healthy subset). Exit NONZERO = NOT permitted / unreadable -> the workflow MUST NOT
// open controls, and NO publication-control / lease / cycle / reservation / publication write occurs. This step itself
// is strictly READ-ONLY. It runs AFTER OLI/Campaign source refresh (which already ran independently) -- so a failure
// here is NOT an overall zero-write claim, only zero PUBLICATION-side writes. 7-bit ASCII, LF.

import { appendFileSync } from "node:fs";
import pg from "pg";
import { loadReleaseEnv } from "./env-bootstrap.mjs";
import { readPartialCycleCapability } from "../../lib/server/sync/priority-partial-capability.js";

loadReleaseEnv();

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const bucket = argOf("bucket");
const ghOut = (k, v) => { const f = process.env.GITHUB_OUTPUT; if (f) { try { appendFileSync(f, k + "=" + v + "\n"); } catch { /* ignore */ } } };

// The partial publication is REGION-scoped: only india|europe-au|us-ca match the priority-partial regex (the legacy
// us|non-us buckets do NOT). Reject anything else BEFORE any DB read, fail closed.
if (!["india", "europe-au", "us-ca"].includes(String(bucket))) {
  ghOut("permitted", "false");
  console.error("STOP PRIORITY_PARTIAL_REGION_UNSUPPORTED: healthy-subset publication is region-scoped (india|europe-au|us-ca); got --bucket=" + bucket + " -- fail closed (ZERO publication writes).");
  process.exit(2);
}

const base = String(process.env.POSTGRES_URL || "").split("?")[0];
if (!base) { ghOut("permitted", "false"); console.error("STOP PRIORITY_PARTIAL_PREFLIGHT_UNREADABLE: POSTGRES_URL unavailable -- fail closed."); process.exit(1); }
const client = new pg.Client({ connectionString: base, ssl: { rejectUnauthorized: false } });
let cap = { permitted: false, reason: "capability-unreadable: connect failed" };
try {
  await client.connect();
  // READ-ONLY, and belt-and-suspenders: a read-only repeatable-read transaction so the two capability SELECTs see a
  // consistent snapshot and can never mutate.
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  cap = await readPartialCycleCapability((sql) => client.query(sql).then((r) => r.rows));
  await client.query("ROLLBACK");
} catch (e) {
  cap = { permitted: false, reason: "capability-unreadable: " + (e && e.message ? e.message : e) };
  try { await client.query("ROLLBACK"); } catch { /* ignore */ }
} finally { try { await client.end(); } catch { /* ignore */ } }

ghOut("permitted", cap.permitted ? "true" : "false");
if (!cap.permitted) {
  console.error("STOP PRIORITY_PARTIAL_MIGRATION_PENDING (" + bucket + "): the priority-partial cycle namespace is NOT permitted by the production schema (" + cap.reason
    + "). Apply the approval-gated migration 20260924_priority_partial_cycle_bucket.sql (MIGRATE_ONLY) first. The workflow will NOT open controls or publish;"
    + " ZERO publication-control/lease/cycle/reservation/publication writes occur (the earlier OLI/Campaign source refresh already ran independently; dashboard LKG preserved).");
  process.exit(1);
}
console.log("PRIORITY_PARTIAL_CAPABILITY_OK (" + bucket + "): open_sync_cycle + sync_cycles_bucket_check permit the priority-partial namespace.");

// ===================== LINEAGE ELIGIBILITY (read-only; genuinely FAIL CLOSED) =====================
// Refine the PROPOSED OLI-eligible subset to EXACTLY the accounts whose durable OLI lineage is PROVABLE, using the
// SAME resolveOliLineageProvenance the derive runtime uses (composed by partitionPartialCycleByLineage): a positive-
// sales provenance OR a rigorously proven zero-row export chain is eligible; anything else -- INCLUDING a non-positive
// `row_count > 0` export (only explicit-zero / pending / cancelled rows) that has no positive-sales rows and no
// row_count=0 export -- is DEFERRED so it can never enter the frozen cycle and block the proven accounts. Strictly
// READ-ONLY (GET reads + the pure partition; the capability probe above used a READ ONLY txn): ZERO controls / leases
// / cycles / reservations / exports / writes. It EMITS the REFINED eligible_ids the workflow's partial_publish MUST
// use. FAIL CLOSED (exit nonzero; zero publication writes) when an evidence reader is missing / malformed / capped /
// timed-out / unreadable, OR when NO account remains eligible (an all-deferred run is NOT a successful publication).
const proposed = [...new Set(String(argOf("eligible-accounts") || "").split(",").map((s) => s.trim()).filter(Boolean))].sort();
const asOf = argOf("as-of");
if (proposed.length === 0) { console.error("STOP PRIORITY_PARTIAL_LINEAGE: --eligible-accounts must be provided + nonempty for the lineage preflight (fail closed)."); process.exit(2); }
if (!asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) { console.error("STOP PRIORITY_PARTIAL_LINEAGE: --as-of=YYYY-MM-DD is required (fail closed)."); process.exit(2); }

const sb = await import("../../lib/server/supabase.js");
const { partitionPartialCycleByLineage } = await import("../../lib/server/sync/source-durable-model.js");
const { sourceRegistryEntry } = await import("../../lib/server/sync/source-registry.js");
const { getDataDoeConnections } = await import("../../lib/server/datadoe-connections.js");
const { organizationFingerprint } = await import("../../lib/server/source-identity.js");
const OLI = "order-line-items";
const oliStart = sourceRegistryEntry(OLI).initialBackfill.start;
const primaryConn = (getDataDoeConnections() || []).find((c) => c.id === "primary");
const orgFp = primaryConn && (primaryConn.organizationFingerprint || organizationFingerprint(primaryConn.apiKey));
if (!orgFp) { console.error("STOP PRIORITY_PARTIAL_LINEAGE_UNREADABLE: cannot resolve the primary organization fingerprint -- fail closed (ZERO publication writes)."); process.exit(1); }

const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + " timed out after " + ms + "ms")), ms))]);
let hist; let zero;
try { hist = await withTimeout(sb.getSourceOliHistoryRows({ organizationFingerprint: orgFp, connectionId: "primary", accountIds: proposed, from: oliStart, to: asOf }), 120000, "positive-history read"); }
catch (e) { console.error("STOP PRIORITY_PARTIAL_LINEAGE_UNREADABLE: positive-sales history read failed/capped/timed-out (" + (e && e.message ? e.message : e) + ") -- fail closed (ZERO publication writes)."); process.exit(1); }
try { zero = await withTimeout(sb.getSourceOliZeroRowProof({ organizationFingerprint: orgFp, connectionId: "primary", accountIds: proposed, sourceKey: OLI }), 120000, "zero-row proof read"); }
catch (e) { console.error("STOP PRIORITY_PARTIAL_LINEAGE_UNREADABLE: zero-row proof read failed/timed-out (" + (e && e.message ? e.message : e) + ") -- fail closed."); process.exit(1); }
if (!Array.isArray(hist)) { console.error("STOP PRIORITY_PARTIAL_LINEAGE_UNREADABLE: positive-sales history read returned a non-array (malformed) -- fail closed."); process.exit(1); }
if (!zero || zero.read !== "ok" || !(zero.byAccount instanceof Map)) { console.error("STOP PRIORITY_PARTIAL_LINEAGE_UNREADABLE: zero-row proof read state=" + (zero && zero.read) + " (missing/malformed/unreadable) -- fail closed."); process.exit(1); }

const positiveHashesByAccount = new Map();
for (const r of hist) {
  const aid = String(r.account_id ?? r.accountId ?? "").trim();
  if (!aid) continue;
  const hh = r.source_request_hash ?? r.sourceRequestHash;
  if (!positiveHashesByAccount.has(aid)) positiveHashesByAccount.set(aid, []);
  positiveHashesByAccount.get(aid).push(typeof hh === "string" && hh.trim() !== "" ? hh : null);
}
const part = partitionPartialCycleByLineage({ accountIds: proposed, positiveHashesByAccount, zeroRowExportsByAccount: zero.byAccount, oliStart, requestedAsOf: asOf });
ghOut("eligible_ids", part.eligible.join(","));
ghOut("eligible_count", String(part.eligible.length));
ghOut("deferred_count", String(part.deferred.length));
if (part.deferred.length) console.log("PRIORITY_PARTIAL_LINEAGE deferred " + part.deferred.length + " account(s) (kept dated LKG): " + part.deferred.map((d) => d.accountId.slice(0, 8) + ":" + d.reason).join(", "));
if (part.eligible.length === 0) {
  console.error("STOP PRIORITY_PARTIAL_ALL_DEFERRED (" + bucket + "): NO proposed account has provable durable OLI lineage -- ZERO publication (this is NOT a successful publication). Controls stay closed; deferred accounts keep dated LKG; typed deferral (non-success).");
  process.exit(1);
}
console.log("PRIORITY_PARTIAL_LINEAGE_OK (" + bucket + "): " + part.eligible.length + " of " + proposed.length + " proposed account(s) have provable lineage; partial_publish uses EXACTLY these refined eligible_ids.");
process.exit(0);
