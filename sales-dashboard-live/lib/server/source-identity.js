// Canonical DataDoe source request identity.
//
// Extracted VERBATIM (byte-identical algorithm) from lib/server/datadoe.js so the
// scheduler — planner, registry declarations, and tests — can compute the SAME
// request_hash the live fetch path computes, without importing the DataDoe/report
// module graph. Because the algorithm is unchanged, existing source_export_cache
// entries keyed by request_hash remain valid, and a declared per-report contract
// resolves to the exact export a browser-triggered report would reuse.
//
// request_hash covers the COMPLETE canonical identity: organization (apiKey
// fingerprint), account scope (sorted ids), source (contract key), columns, date
// window (from/to), row limit, groupBy grain, aggregations, and ordering. Same
// identity => one export; ANY difference => a distinct export.

import { createHash } from "node:crypto";
import { sourceContractForId } from "./source-contracts.js";

export function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
  );
}

export function sourceRequestIdentity({ apiKey, sourceId, columns, ids, from, to, limit, options }) {
  const contract = sourceContractForId(sourceId);
  const organizationFingerprint = sha256(apiKey).slice(0, 24);
  const accountScopeHash = sha256([...ids].map(String).sort().join("\u001f"));
  const requestMeta = stableValue({
    source: contract?.key || String(sourceId),
    columns: [...columns].map(String).sort(),
    from: from || null,
    to: to || null,
    limit,
    groupBy: [...(options.groupBy || [])].map(String).sort(),
    aggregations: [...(options.aggregations || [])].map(stableValue).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    orderByColumn: options.orderByColumn || "date",
    orderByDirection: options.orderByDirection || "ASC",
  });
  const requestHash = sha256(JSON.stringify({ organizationFingerprint, accountScopeHash, requestMeta }));
  return { requestHash, organizationFingerprint, accountScopeHash, requestMeta };
}
