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

// The organization fingerprint of a DataDoe apiKey (first 24 hex of its sha256). The
// scheduler uses this to VERIFY a source job is routed to the connection that owns it —
// a primary job may only run on the primary key, a dd-secondary job only on the
// secondary key — before any DataDoe call. Byte-identical to the value baked into
// request_hash, so identities are unchanged.
export function organizationFingerprint(apiKey) {
  return sha256(apiKey).slice(0, 24);
}

// Deterministic, NON-SECRET owner identity for source-job ownership memberships
// (sync_source_job_owners.owner_id). It distinguishes the four ownership dimensions the durable model
// requires: report/workflow family (`reportKey`), connection/organization boundary (`connectionId`),
// organization fingerprint (`organizationFingerprint`), and account scope (`accountScopeHash`). The same
// report/account/org across staged rounds resolves to the SAME owner_id; different accounts (distinct
// account_scope_hash) or organizations (distinct organization_fingerprint / connection) never share one;
// different reports may hold different owner_ids for the SAME request_hash. It NEVER includes an API key,
// Supabase key, token, or other secret -- organization_fingerprint is itself a non-reversible fingerprint
// already stored openly, and account_scope_hash is a non-reversible hash of the account ids. Returns null
// when any dimension is missing, so a caller can fail closed rather than form an ambiguous owner. This
// value does NOT feed request_hash (source identity is unchanged).
export function sourceJobOwnerId({ reportKey, connectionId, organizationFingerprint, accountScopeHash }) {
  const rk = String(reportKey || "").trim();
  const conn = String(connectionId || "").trim();
  const org = String(organizationFingerprint || "").trim();
  const scope = String(accountScopeHash || "").trim();
  if (!rk || !conn || !org || !scope) return null;
  return sha256(JSON.stringify(["source-owner/v1", rk, conn, org, scope])).slice(0, 32);
}

// The unit-separator (U+001F) joining seller ids in the account-scope hash, matching the byte used inline in
// sourceRequestIdentity below. Defined via fromCharCode so it is unambiguous in source.
const SCOPE_ID_SEPARATOR = String.fromCharCode(0x1f);

// The account-scope hash: sha256 of the sorted, unit-separator-joined seller ids. A single account's scope
// and a batch's scope use the IDENTICAL formula, so an individual account's OWNER scope
// (accountScopeHash([sellerId])) and a batch's CANONICAL scope (accountScopeHash(sortedBatchIds)) are
// directly comparable and never collide unless the id SETS are identical. Byte-identical to the value
// sourceRequestIdentity folds into request_hash, so existing identities are unchanged.
export function accountScopeHash(ids) {
  return sha256([...ids].map(String).sort().join(SCOPE_ID_SEPARATOR));
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
