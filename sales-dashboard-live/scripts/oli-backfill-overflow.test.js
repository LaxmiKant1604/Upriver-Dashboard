// Adaptive OLI-backfill row-cap self-heal: the pure resolver + the durable evidence reader (offline, injected I/O).
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { accountScopeHash } from "../lib/server/source-identity.js";
import {
  oliBackfillWeeklySellersFrom, readRecentTruncatedOliBackfillOwnership, DEFAULT_OLI_BACKFILL_EVIDENCE_MAX_AGE_DAYS,
} from "../lib/server/sync/oli-backfill-overflow.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
const sh = (s) => accountScopeHash([s]);
writeSync(1, "oli-backfill-overflow\n");

// ---- A. oliBackfillWeeklySellersFrom: resolve truncated owner scope hashes -> current-plan raw seller ids ----
{
  const truncated = [sh("SDE"), sh("S_OTHER")];
  const r = oliBackfillWeeklySellersFrom({ truncatedScopeHashes: truncated, sellerIds: ["SDE", "S_HEALTHY", "S1"] });
  ok("A: a current seller whose scope hash is in the truncated set is selected (SDE)", r.has("SDE"));
  ok("A: a healthy current seller (no truncation) is NOT selected", !r.has("S_HEALTHY") && !r.has("S1"));
  ok("A: a truncated seller absent from the current plan is ignored (S_OTHER)", !r.has("S_OTHER") && r.size === 1);
  ok("A: empty evidence -> empty set (byte-identical default chunking)", oliBackfillWeeklySellersFrom({ truncatedScopeHashes: [], sellerIds: ["SDE"] }).size === 0);
  ok("A: accepts a Set of scope hashes too", oliBackfillWeeklySellersFrom({ truncatedScopeHashes: new Set([sh("SDE")]), sellerIds: ["SDE"] }).has("SDE"));
  ok("A: blank/malformed seller ids are skipped", !oliBackfillWeeklySellersFrom({ truncatedScopeHashes: [sh("SDE")], sellerIds: ["", null, "SDE"] }).has(""));
}

// ---- B. readRecentTruncatedOliBackfillOwnership: TRUNCATED OLI-backfill filter + scope/current-cycle/fail-soft ----
await (async () => {
  const readRecentCycleIds = async () => ["cyc-prior", "cyc-current"];
  const jobsByCycle = {
    "cyc-prior": [
      { request_hash: "H_T", source_key: "order-line-items", fetch_status: "failed", error_code: "TRUNCATED", terminal: true },
      { request_hash: "H_OK", source_key: "order-line-items", fetch_status: "succeeded", error_code: null, terminal: false }, // succeeded -> not evidence
      { request_hash: "H_FBA", source_key: "fba-inventory-health", fetch_status: "failed", error_code: "TRUNCATED", terminal: true }, // wrong source
      { request_hash: "H_NT", source_key: "order-line-items", fetch_status: "failed", error_code: "TRUNCATED", terminal: false }, // not terminal
    ],
    "cyc-current": [
      { request_hash: "H_CUR", source_key: "order-line-items", fetch_status: "failed", error_code: "TRUNCATED", terminal: true }, // the CURRENT cycle -> excluded
    ],
  };
  const ownersByCycle = {
    "cyc-prior": [
      { request_hash: "H_T", request_key: "source-oli:slice-v1", account_scope_hash: sh("SDE"), connection_id: "primary", organization_fingerprint: "ORG", owner_status: "active" },
      { request_hash: "H_T", request_key: "daily-reporting:oli-sales", account_scope_hash: sh("SREPORT"), connection_id: "primary", organization_fingerprint: "ORG", owner_status: "active" }, // wrong request_key
      { request_hash: "H_T", request_key: "source-oli:slice-v1", account_scope_hash: sh("SSTALE"), connection_id: "primary", organization_fingerprint: "ORG", owner_status: "stale" }, // stale
      { request_hash: "H_T", request_key: "source-oli:slice-v1", account_scope_hash: sh("SCONN"), connection_id: "dd-secondary", organization_fingerprint: "ORG", owner_status: "active" }, // wrong connection
      { request_hash: "H_T", request_key: "source-oli:slice-v1", account_scope_hash: sh("SORG"), connection_id: "primary", organization_fingerprint: "OTHER", owner_status: "active" }, // wrong org
    ],
    "cyc-current": [
      { request_hash: "H_CUR", request_key: "source-oli:slice-v1", account_scope_hash: sh("SNEW"), connection_id: "primary", organization_fingerprint: "ORG", owner_status: "active" },
    ],
  };
  const base = { now: () => Date.parse("2026-09-16T00:00:00Z"), connectionId: "primary", organizationFingerprint: "ORG",
    readRecentCycleIds, readSourceJobs: async (cid) => jobsByCycle[cid], readOwners: async (cid) => ownersByCycle[cid] };

  const set = await readRecentTruncatedOliBackfillOwnership({ cycleBucket: "europe-au", excludeCycleId: "cyc-current", ...base });
  ok("B: only the in-scope OLI-backfill owner is kept (SDE); report-key/stale/wrong-connection/wrong-org excluded", set.has(sh("SDE")) && set.size === 1);
  ok("B: the CURRENT cycle's truncation (SNEW) is EXCLUDED (stable across continuations)", !set.has(sh("SNEW")));

  const noExclude = await readRecentTruncatedOliBackfillOwnership({ cycleBucket: "europe-au", excludeCycleId: null, ...base });
  ok("B: WITHOUT excludeCycleId the current cycle IS included (proves the exclusion is what drops SNEW)", noExclude.has(sh("SDE")) && noExclude.has(sh("SNEW")));

  const failSoft = await readRecentTruncatedOliBackfillOwnership({ cycleBucket: "europe-au", excludeCycleId: "cyc-current", ...base, readRecentCycleIds: async () => { throw new Error("db down"); } });
  ok("B: a read failure fails soft to empty (never blocks planning)", failSoft.size === 0);
  const missingReaders = await readRecentTruncatedOliBackfillOwnership({ cycleBucket: "europe-au" });
  ok("B: missing readers -> empty (byte-identical default chunking)", missingReaders.size === 0);
  ok("B: the recency window default is 14 days", DEFAULT_OLI_BACKFILL_EVIDENCE_MAX_AGE_DAYS === 14);
})();

// ---- C. SINGLE-OWNER only: a MULTI-seller truncation never flags any member (a sparse batch-mate stays efficient) ----
await (async () => {
  const readRecentCycleIds = async () => ["cyc-1"];
  const jobs = [
    { request_hash: "H_SOLO", source_key: "order-line-items", fetch_status: "failed", error_code: "TRUNCATED", terminal: true },
    { request_hash: "H_MULTI", source_key: "order-line-items", fetch_status: "failed", error_code: "TRUNCATED", terminal: true },
  ];
  const owners = [
    // H_SOLO: exactly ONE in-scope owner (a seller that truncates ALONE) -> trusted.
    { request_hash: "H_SOLO", request_key: "source-oli:slice-v1", account_scope_hash: sh("SOLO"), connection_id: "primary", organization_fingerprint: "ORG", owner_status: "active" },
    // H_MULTI: TWO in-scope owners (the combined rows truncated) -> NOT trusted; neither member weekly-sliced.
    { request_hash: "H_MULTI", request_key: "source-oli:slice-v1", account_scope_hash: sh("MA"), connection_id: "primary", organization_fingerprint: "ORG", owner_status: "active" },
    { request_hash: "H_MULTI", request_key: "source-oli:slice-v1", account_scope_hash: sh("MB"), connection_id: "primary", organization_fingerprint: "ORG", owner_status: "active" },
  ];
  const set = await readRecentTruncatedOliBackfillOwnership({ cycleBucket: "europe-au", connectionId: "primary", organizationFingerprint: "ORG",
    now: () => Date.parse("2026-09-16T00:00:00Z"), readRecentCycleIds, readSourceJobs: async () => jobs, readOwners: async () => owners });
  ok("C: a SINGLE-owner truncation is trusted (SOLO)", set.has(sh("SOLO")));
  ok("C: a MULTI-seller truncation flags NEITHER member (MA, MB) -> no sparse batch-mate weekly-sliced", !set.has(sh("MA")) && !set.has(sh("MB")) && set.size === 1);
})();

writeSync(1, `\noli-backfill-overflow: ${passed} assertions passed\n`);
