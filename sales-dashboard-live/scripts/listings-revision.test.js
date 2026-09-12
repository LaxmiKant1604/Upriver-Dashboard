// WORK C -- PURE revision identity for listing-health-v3 (listings-revision.js). Proves the deterministic per-account
// revision folds BOTH durable pointers, proves D-1 by snapshot.as_of === requestedAsOf (older AND future defer), folds
// as_of into the content tokens (the listings request hash is date-FREE), and defers on every missing/blank/invalid
// pointer. No I/O. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import {
  computeListingHealthV3AccountRevision,
  listingsContentProvenanceToken,
  listingsRawContentProvenanceToken,
  LISTINGS_REVISION_STATUS,
} from "../lib/server/sync/listings-revision.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "listings-revision\n");

const ORG = "org-1";
const ACCT = "acct-00";
const ASOF = "2026-09-04";
// A durable pointer row (snake_case, exactly as getSourceListingsSnapshot projects it).
const ptr = (o = {}) => ({
  organization_fingerprint: ORG, connection_id: "primary", account_id: ACCT, marketplace: "US",
  as_of: o.as_of ?? ASOF, object_path: o.object_path ?? `source-snapshots/v2/${ORG}/primary/listings/${ACCT}/${o.payload_sha ?? "sha-l"}.json`,
  payload_sha: o.payload_sha ?? "sha-l", row_count: o.row_count ?? 3, payload_bytes: 100,
  source_request_hash: o.source_request_hash ?? "rh-l", validated_at: o.validated_at ?? "2026-09-04T06:00:00.000Z",
});
const base = { organizationFingerprint: ORG, connectionId: "primary", accountId: ACCT, requestedAsOf: ASOF };
const rev = (over = {}) => computeListingHealthV3AccountRevision({
  ...base,
  listingsSnapshot: over.l === undefined ? ptr({ payload_sha: "sha-l", source_request_hash: "rh-l" }) : over.l,
  listingsRawSnapshot: over.r === undefined ? ptr({ payload_sha: "sha-r", source_request_hash: "rh-r" }) : over.r,
  ...(over.rest || {}),
});

// ---- (1) eligible AVAILABLE ----
{
  const v = rev();
  ok("eligible: both pointers D-1 + rows>0 => AVAILABLE", v.eligible === true && v.status === LISTINGS_REVISION_STATUS.AVAILABLE);
  ok("revisionId is a 32-hex string", typeof v.revisionId === "string" && /^[0-9a-f]{32}$/.test(v.revisionId));
  ok("deps is EMPTY (listings/raw are per-account durable pointers, never cycle jobs)", Array.isArray(v.deps) && v.deps.length === 0);
  ok("contentDeps carries EXACTLY the two Listings tokens", Array.isArray(v.contentDeps) && v.contentDeps.length === 2);
  ok("contentDeps[0] === listingsContentProvenanceToken(listings)", v.contentDeps[0] === listingsContentProvenanceToken({ accountId: ACCT, connectionId: "primary", asOf: ASOF, requestHash: "rh-l", contentSha: "sha-l" }));
  ok("contentDeps[1] === listingsRawContentProvenanceToken(raw)", v.contentDeps[1] === listingsRawContentProvenanceToken({ accountId: ACCT, connectionId: "primary", asOf: ASOF, requestHash: "rh-r", contentSha: "sha-r" }));
}

// ---- (2) PROVEN_EMPTY: both row_count=0 ----
{
  const v = rev({ l: ptr({ row_count: 0, payload_sha: "sha-l" }), r: ptr({ row_count: 0, payload_sha: "sha-r" }) });
  ok("both pointers row_count=0 => PROVEN_EMPTY (valid empty, never a fabricated zero)", v.eligible === true && v.status === LISTINGS_REVISION_STATUS.PROVEN_EMPTY);
}

// ---- (3) MISSING / defer ladder ----
const miss = (n, over, reason) => { const v = rev(over); ok(n, v.eligible === false && v.status === LISTINGS_REVISION_STATUS.MISSING && v.revisionId === null && v.deps.length === 0 && v.contentDeps.length === 0 && (reason ? v.reason === reason : true)); };
miss("defer: no listings pointer", { l: null }, "no-durable-listings-snapshot");
miss("defer: no listings-raw pointer", { r: null }, "no-durable-listings-raw-snapshot");
miss("defer: listings blank request hash", { l: ptr({ source_request_hash: "" }) }, "listings-snapshot-request-hash-blank");
miss("defer: listings blank content sha", { l: ptr({ payload_sha: "" }) }, "listings-snapshot-content-hash-blank");
miss("defer: listings negative row_count", { l: ptr({ row_count: -1 }) }, "listings-snapshot-row-count-invalid");
miss("defer: raw blank content sha", { r: ptr({ payload_sha: "" }) }, "listings-raw-snapshot-content-hash-blank");
miss("defer: listings OLDER as_of than requested (stale, never publish as fresh)", { l: ptr({ as_of: "2026-09-03" }) }, "listings-not-d1");
miss("defer: listings FUTURE as_of than requested (unexpected)", { l: ptr({ as_of: "2026-09-05" }) }, "listings-not-d1");
miss("defer: raw OLDER as_of than requested", { r: ptr({ as_of: "2026-09-03" }) }, "listings-raw-not-d1");
miss("defer: incomplete boundary (missing accountId)", { rest: { accountId: "" } }, "incomplete-account-boundary");
miss("defer: incomplete boundary (missing requestedAsOf)", { rest: { requestedAsOf: "" } }, "incomplete-account-boundary");

// ---- (4) revisionId determinism + change-on-content-change (BOTH sides) ----
{
  ok("revisionId is deterministic for identical inputs", rev().revisionId === rev().revisionId);
  ok("revisionId CHANGES when the LISTINGS payload_sha changes", rev().revisionId !== rev({ l: ptr({ payload_sha: "sha-l-2", source_request_hash: "rh-l" }) }).revisionId);
  ok("revisionId CHANGES when the RAW payload_sha changes", rev().revisionId !== rev({ r: ptr({ payload_sha: "sha-r-2", source_request_hash: "rh-r" }) }).revisionId);
  ok("revisionId CHANGES when the LISTINGS request hash changes", rev().revisionId !== rev({ l: ptr({ payload_sha: "sha-l", source_request_hash: "rh-l-2" }) }).revisionId);
}

// ---- (5) content token folds as_of (date advance OR same-date correction => distinct token) ----
{
  const tDay1 = listingsContentProvenanceToken({ accountId: ACCT, connectionId: "primary", asOf: "2026-09-04", requestHash: "rh-l", contentSha: "sha-l" });
  const tDay2 = listingsContentProvenanceToken({ accountId: ACCT, connectionId: "primary", asOf: "2026-09-05", requestHash: "rh-l", contentSha: "sha-l" });
  ok("a next-day as_of yields a DISTINCT content token (the live report from the old day is provably stale)", tDay1 !== tDay2 && tDay1.includes("2026-09-04") && tDay2.includes("2026-09-05"));
  const tSha1 = listingsContentProvenanceToken({ accountId: ACCT, connectionId: "primary", asOf: "2026-09-04", requestHash: "rh-l", contentSha: "sha-A" });
  const tSha2 = listingsContentProvenanceToken({ accountId: ACCT, connectionId: "primary", asOf: "2026-09-04", requestHash: "rh-l", contentSha: "sha-B" });
  ok("a same-date payload_sha correction yields a DISTINCT content token", tSha1 !== tSha2);
  ok("the listings token and the listings-raw token differ by source key", listingsContentProvenanceToken({ accountId: ACCT, asOf: ASOF, requestHash: "h", contentSha: "s" }) !== listingsRawContentProvenanceToken({ accountId: ACCT, asOf: ASOF, requestHash: "h", contentSha: "s" }));
  ok("the listings token pins the 'listings' source key", listingsContentProvenanceToken({ accountId: ACCT, asOf: ASOF, requestHash: "h", contentSha: "s" }).startsWith("listings|"));
  ok("the listings-raw token pins the 'listings-raw' source key", listingsRawContentProvenanceToken({ accountId: ACCT, asOf: ASOF, requestHash: "h", contentSha: "s" }).startsWith("listings-raw|"));
}

writeSync(1, `\nlistings-revision: ${passed} assertions passed\n`);
