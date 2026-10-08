// Scheduler v2 -- the insight reports' SAVED inventory evidence as a derived-context dependency (Listings inventory
// CUTOVER, owner decision 2026-10-08).
//
// Sales Movers / Buy Box Loss / Listing Health v1 no longer own an FBA Inventory Health fragment (no Health export is
// created by any path). Their scheduled derive instead receives, through the report worker's loadDerivedContext, the
// SAME saved evidence the manual refresh reads (lib/server/reports/common.js readInsightInventoryEvidence): the
// account's saved canonical Listings rows and its LAST SAVED durable FBA Inventory Health snapshot (the dated read-only
// bridge). The derive (report-derivation.js, derivedContextKeys [INSIGHT_INVENTORY_CONTEXT_KEY]) then makes the ONE
// per-account decision -- validated Listings, else the bridge within HEALTH_BRIDGE_MAX_AGE_DAYS of the as-of, else
// Unavailable (never 0).
//
// READ-ONLY and FAIL-SOFT: every read failure is a typed unavailable reason inside the evidence (the report still
// publishes; its stock is Unavailable with the reason) -- never an export, never a write, never a throw. For every
// other report key it returns {} (a safe union with the other loaders). 7-bit ASCII, LF.

import { resolveDataDoeAccountIds } from "../datadoe-connections.js";
import { organizationFingerprint as organizationFingerprintOf } from "../source-identity.js";
import { readInsightInventoryEvidence } from "../reports/common.js";
import { INSIGHT_INVENTORY_CONTEXT_KEY } from "../reports/derivation-core.js";

export const INSIGHT_INVENTORY_REPORT_KEYS = Object.freeze(["sales-movers", "buy-box-loss", "listing-health"]);
const OWNED = new Set(INSIGHT_INVENTORY_REPORT_KEYS);
const S = (v) => (v == null ? "" : String(v));
const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * Make the report-worker `loadDerivedContext` callback for the insight reports.
 *   connections -- the resolved DataDoe connections (account -> raw seller id + connection + org fingerprint).
 *   readEvidence -- injectable (tests); default readInsightInventoryEvidence (read-only Supabase readers).
 *   readers -- optional { readPointer, readPayload, readHealthPointer, readHealthPayload } forwarded to readEvidence.
 * Returns async ({ reportKey, accountId, planned }) => {} | { insightInventoryEvidence: { listings, healthBridge } }.
 */
export function makeInsightInventoryContextLoader({ connections, readEvidence = readInsightInventoryEvidence, readers = {} } = {}) {
  return async ({ reportKey, accountId, planned } = {}) => {
    if (!OWNED.has(S(reportKey))) return {};
    const context = (planned && planned.context) || {};
    const asOf = context.to != null ? S(context.to) : "";
    if (!isDate(asOf)) return {}; // no authoritative as-of: the derive reports the evidence as not loaded (Unavailable)
    let resolved;
    try { resolved = resolveDataDoeAccountIds([accountId], connections); } catch (_e) { return {}; }
    if (!resolved || !Array.isArray(resolved.rawAccountIds) || resolved.rawAccountIds.length !== 1) return {};
    const rawSellerId = S(resolved.rawAccountIds[0]);
    const connection = resolved.connection || null;
    const connectionId = connection && connection.id === "secondary" ? "dd-secondary" : "primary";
    let organizationFingerprint = connection && connection.organizationFingerprint ? S(connection.organizationFingerprint) : "";
    if (!organizationFingerprint) {
      try { organizationFingerprint = S(organizationFingerprintOf(connection && connection.apiKey)); } catch (_e) { organizationFingerprint = ""; }
    }
    if (!organizationFingerprint) return {};
    try {
      const evidence = await readEvidence({
        ids: [rawSellerId], to: asOf,
        listings: { organizationFingerprint, connectionId, healthScopeKey: S(accountId), ...(readers || {}) },
      });
      if (!evidence || typeof evidence !== "object") return {};
      return { [INSIGHT_INVENTORY_CONTEXT_KEY]: { listings: evidence.listings || null, healthBridge: evidence.healthBridge || null } };
    } catch (_e) {
      return {}; // fail-soft: the derive reports the evidence as not loaded (Unavailable, never 0)
    }
  };
}
