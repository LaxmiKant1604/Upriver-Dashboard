# Saved-data publication reconciler — STOP-AND-REPORT + prepared (UNAPPLIED) migration proposals

Date: 2026-09-11. Author: reconciler extension work (shared core + FBA family).

This document is the **stop-and-report** for the report families that **cannot** be reconciled
zero-export from EXISTING durable records, plus the **prepared (unapplied) migration designs**
that would make them reconcilable. Per the working boundary "*If a migration is genuinely
required, prepare it but do not apply it. Explain why existing durable records cannot support
the requirement first.*"

**IMPORTANT — why the SQL below is NOT in `supabase/migrations/`:** a full `npm run db:migrate`
applies every *unledgered* file in `supabase/migrations/` in order (the ledger is currently a
clean no-op — all 53 files applied). Dropping a not-yet-final proposal there would make
`db:migrate` silently apply it. These are **design sketches to finalize against the real data
model first**, so they live here, not as executable migration files. When a proposal is
finalized + approved, it becomes a numbered `supabase/migrations/*.sql` with the same
`PREPARED / UNAPPLIED — APPROVAL-GATED` header convention as `20260924_priority_partial_cycle_bucket.sql`.

---

## A. LISTINGS — NOT zero-export reconcilable today (STOP-AND-REPORT)

**Why existing durable records cannot support it.** The `listings` source is declared
`storage: "cycle-cache"` (`lib/server/sync/source-registry.js`): its rows live ONLY in
`public.source_export_cache`, which is TTL-bounded and pruned (`supabase.js`; migration
`20260806`). There is **no durable listings table** anywhere in the 53 migrations (the durable
tables are OLI `source_oli_daily_history`, settlements, returns, ads `ads_daily_source_rows` +
`ads_sync_coverage` + `ads_sync_state`, and the durable-snapshot `source_snapshots` for catalog +
FBA — none for listings). The per-account listings read identity is deliberately **date-free and
stable day-to-day** (`listing-health-v3-materialize.js`), so a corrected same-date export reuses
the SAME `request_hash`; there is **no coverage-window chain and no byte-stable content
revision** analogous to OLI's request-hash provenance or Ads' `content_rev`. The live-served
Listing Health is `listing-health-v1`, whose sales come from Profit-by-SKU (also cycle-cache),
not durable OLI.

A zero-export reconciler therefore has **no durable input to re-derive from** and **no
content-revision to compare** — it cannot establish exact account + date + lineage + durable
revision evidence. Building it over the TTL cache would violate "reconcile only from saved rows"
and would silently mis-fire after cache eviction. **STOP-AND-REPORT.**

### Prepared migration DESIGN (do not apply): a durable per-account Listings store

```sql
-- PROPOSAL — NOT an applied migration. Finalize against the REAL listings export schema first.
-- public.source_listings_snapshot: ONE durable latest-good pointer per (org, connection, account),
-- content-addressed exactly like source_snapshots (20260820), so the reconciler re-derives Listing
-- Health from saved rows and detects a same-date correction via a byte-stable content hash.
create table if not exists public.source_listings_snapshot (
  organization_fingerprint text not null,
  connection_id            text not null default 'primary',
  account_id               text not null,
  as_of                    date not null,             -- the cycle as-of the listings snapshot covers
  object_path              text not null,             -- content-addressed object (rows payload)
  payload_sha              text not null,             -- sha256 of the canonical rows -> the content revision
  row_count                int  not null,
  source_request_hash      text not null,             -- the listings export request identity (provenance)
  validated_at             timestamptz not null,
  updated_at               timestamptz not null default now(),
  primary key (organization_fingerprint, connection_id, account_id)
);
-- record_source_listings_snapshot(...) -> 'replaced' | 'unchanged' | 'stale-save' | 'conflict'
-- (strictly-newer validated_at CAS; equal validated_at + same payload_sha = 'unchanged'), mirroring
-- record_source_snapshot so a same-date correction (new payload_sha) is durably detectable.
-- A genuine bounded single-day row_count=0 export is a VALID EMPTY (issuesAvailable:false), never zero.
```

The Listing Health derive would then read `source_listings_snapshot` (bridge analogous to
`buildDurableOli`), a new `computeListingsAccountRevision` would fold `payload_sha` +
`source_request_hash` + the schema/report version, and a `listings`-family adapter would plug into
`buildSavedDataReconciler` exactly like the FBA adapter. This requires the scheduler's listings
save path to ALSO persist the durable snapshot (additive, like the FBA persist at
`source-bucket-sync.js`), which is a scheduler-side change to be scoped separately.

---

## B. LISTINGS RAW — NOT zero-export reconcilable today (STOP-AND-REPORT)

**Why existing durable records cannot support it.** `listings-raw` is likewise
`storage: "cycle-cache"` (`source-registry.js`) — no durable store, only `fetched_at`
timestamps (not a content fingerprint). Additionally:

- In `report-derivation.js`, `listing-health` (live v1) declares
  `optionalRequestKeys: ["listing-health:listings-raw"]` and `listing-health-v3` declares
  `optionalRequestKeys: ["listing-health-v3:listings-raw", "listing-health-v3:inventory"]`, i.e.
  **Listings Raw is an OPTIONAL dependency** in both existing code paths (an approved degraded
  policy: raw disabled -> `issuesAvailable:false` + enable hint, NOT a failure). That exact
  optional contract must be preserved and proven with tests — the reconciler must never mark
  Listing Health fresh on the strength of raw alone, and must never treat missing raw as a failure.
- `listing-health-v3` has **no live snapshot contract** at all (it is absent from
  `SCHEDULER_LIVE_SNAPSHOT_CONTRACTS` — a dormant shadow/read-only preview), so there is no live
  dashboard binding for `evaluatePublicationBinding` / `buildLiveReadback` to reconcile.

So Listings Raw as a distinct durable dependency does not exist, and the composite Listings +
Listings-Raw dependency fingerprint (never a single ambiguous timestamp) cannot be computed from
saved rows. **STOP-AND-REPORT.**

### Prepared migration DESIGN (do not apply): a durable Listings-Raw store + composite fingerprint

```sql
-- PROPOSAL — NOT an applied migration.
-- public.source_listings_raw_snapshot: same shape as source_listings_snapshot (A), a SEPARATE
-- durable dependency (never merged with Listings). Its payload_sha is the raw content revision.
-- The reconciler then computes a DETERMINISTIC COMPOSITE dependency fingerprint =
--   sha256([ listings.payload_sha, listings.source_request_hash,
--            listings_raw.payload_sha, listings_raw.source_request_hash ].join('|'))
-- keyed by the SAME (org, connection, account, as_of) on BOTH sides, so a Listing Health snapshot
-- is marked fresh ONLY when every REQUIRED dependency for that exact account/as-of is proven, raw
-- stays optional (its absence degrades issuesAvailable, never blocks), and cross-account /
-- cross-cycle / cross-params joins are impossible (the composite key binds both revisions to one
-- account + as-of; a mismatch on either side is not-fresh). Mirrors the existing
-- brand-view-dependency-fingerprint composite-provenance pattern.
```

---

## C. FBA same-date intra-day corrections — bounded gap + prepared content-provenance link

The FBA reconciler (shipped) reconciles `brand-inventory` for the **missing / unpromoted /
older-as-of / date-advanced** cases from EXISTING durable records with **zero working-behavior
change**: the durable FBA `source_request_hash` is DATE-addressed and is already recorded in
`brand-inventory`'s `depends_on` (proven by `source-production-hardening.test.js`'s account-exact
lineage assertions), so `revisionCoveredByJob` correctly marks a dashboard built from an OLDER
day's FBA export STALE.

**The bounded gap.** Because the FBA request hash is DATE-addressed (`from === to === D-1`), an
**intra-day SAME-DATE correction** (the provider re-itemizes the same D-1 snapshot, changing
`payload_sha` under an unchanged `source_request_hash`) is NOT, on its own, detectable through
`depends_on`. Such a correction is repaired on the **next date advance** (D-1 rolls forward -> new
request hash -> the reconciler re-derives from the current, corrected durable FBA). Detecting it
**intra-day, content-grounded and efficiently** is not possible from existing durable records:
`payload_sha` is not recorded anywhere the reconciler can compare against the live dashboard (the
FBA snapshot is persisted separately from — and its `payload_sha` is not folded into — the
brand-inventory lineage), and `source_snapshots.validated_at` advances on every re-persist (a
timestamp, not a content signal), so it cannot serve as the authority.

### Prepared change (do not apply): record the durable FBA content identity in brand-inventory lineage

The minimal, additive change (analogous to the Ads `content_rev` migration `20260923`, which
existed for exactly this same-window-correction reason) is to fold the durable FBA snapshot's
`payload_sha` into `brand-inventory`'s `depends_on` at derive time (the FBA snapshot — with its
`payload_sha` — is already READ at brand-inventory derive time via `readSnapshot` in
`source-bucket-sync-runtime.js`). With `"fba-content:" + payload_sha` present in `depends_on`, the
FBA revision's `deps` can include that content token and the SAME `revisionCoveredByJob` mechanism
detects a same-date correction (new `payload_sha` not covered by the prior job -> STALE). This is a
change to the hot derive-time lineage binding used by the normal scheduler, so it is deliberately
NOT applied here (it needs its own review + a re-run of the scheduler/source-bucket-sync suites);
it is a small, additive follow-up once the FBA reconciler passes a natural production cycle. No
database migration is required for this one (it changes only what strings are written into the
existing `sync_report_jobs.depends_on` array).

---

## Summary

| Family | Zero-export reconcilable from existing durable records? | Action taken |
|---|---|---|
| OLI (existing) | yes | refactored onto the shared core, byte-for-byte preserved |
| FBA Inventory → brand-inventory | yes, except intra-day same-date corrections | **shipped** (dry-run default) + bounded-gap note (C) |
| FBA Inventory → fba-plan | no (derive reads TTL cache; US needs non-durable AWD) | documented; needs a durable-inventory bridge (future) |
| Listings | **no** (cycle-cache only; no content revision) | **STOP-AND-REPORT** + prepared design (A) |
| Listings Raw | **no** (cycle-cache only; v3 has no live contract) | **STOP-AND-REPORT** + prepared design (B) |

No migration was applied. No GitHub variable was set. No workflow was dispatched. No provider
export/token was performed.
