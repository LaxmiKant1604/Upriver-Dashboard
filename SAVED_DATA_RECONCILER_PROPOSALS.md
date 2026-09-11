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

## C. FBA same-date intra-day corrections — CLOSED via durable content-provenance (implemented)

The FBA reconciler (shipped) reconciles `brand-inventory` for the **missing / unpromoted /
older-as-of / date-advanced** cases from EXISTING durable records with **zero working-behavior
change**: the durable FBA `source_request_hash` is DATE-addressed, so `revisionCoveredByJob`
correctly marks a dashboard built from an OLDER day's FBA export STALE.

**The former bounded gap — now closed.** Because the FBA request hash is DATE-addressed
(`from === to === D-1`), an **intra-day SAME-DATE correction** (the provider re-itemizes the same
D-1 snapshot, changing `payload_sha` under an unchanged `source_request_hash`) is NOT detectable
through `depends_on` alone — the request hash is unchanged. This was previously a bounded gap
repaired only on the next date advance. It is now **detected and repaired immediately** via a
durable CONTENT-provenance dependency (below).

### Implemented change: record the durable FBA content identity (migration PREPARED-UNAPPLIED)

A new additive column `sync_report_jobs.durable_content_deps jsonb` (migration **20260925**,
PREPARED but UNAPPLIED and APPROVAL-GATED) records a durable FBA CONTENT-provenance token. The SQL
file `supabase/migrations/20260925_sync_report_jobs_durable_content_deps.sql` DOES live in
`supabase/migrations/` (like every prepared migration in this repo), so its "unapplied" state rests
ONLY on it being absent from the `app_schema_migrations` ledger — a plain `npm run db:migrate` (no
`MIGRATE_ONLY`) globs every `.sql` there and WOULD apply it. Until explicit sign-off, do NOT run a
plain `db:migrate`; apply EXACTLY this one file, when approved, via
`MIGRATE_ONLY=20260925_sync_report_jobs_durable_content_deps.sql npm run db:migrate` (matching the
file's own header). The column is read fail-soft and written only when non-empty (exactly the Ads
`content_rev` `20260923` pattern), so the code runs correctly whether or not it has been applied. The
token:

```
fbaContentProvenanceToken = "<sourceKey>|<accountId>|<connectionId>|<requestHash>|<payload_sha>"
```

with NO as-of field — the FBA request hash already IS the D-1 identity, so the token is
path-independent. BOTH derive paths record the SAME token: the normal scheduler brand-inventory
derive (`source-bucket-sync-runtime.js`, from the hydrated FBA snapshot it already reads) AND the
reconciler's dedicated release (`fba-brand-inventory-release.js`). `revisionCoveredByJob` now
requires `revision.contentDeps ⊆ job.durable_content_deps` IN ADDITION to `deps ⊆ depends_on`, so a
same-date correction (new `payload_sha` -> new token -> not covered) is STALE and is re-derived on
the next reconcile pass. A SEPARATE column (not `depends_on`) is used deliberately: `depends_on` is
the OLI-shared lineage the OLI reconciler reads, and OLI revisions carry no `contentDeps`, so their
`revisionCoveredByJob` behaviour is byte-for-byte unchanged. Production acceptance still requires
applying migration 20260925 + a natural cycle before FBA live promotion is enabled.

---

## Summary

| Family | Zero-export reconcilable from existing durable records? | Action taken |
|---|---|---|
| OLI (existing) | yes | refactored onto the shared core, byte-for-byte preserved |
| FBA Inventory → brand-inventory | yes (incl. intra-day same-date corrections, via durable content-provenance) | **shipped** (dry-run default); same-date gap CLOSED (C); migration 20260925 prepared-unapplied |
| FBA Inventory → fba-plan | no (derive reads TTL cache; US needs non-durable AWD) | documented; needs a durable-inventory bridge (future) |
| Listings | **no** (cycle-cache only; no content revision) | **STOP-AND-REPORT** + prepared design (A) |
| Listings Raw | **no** (cycle-cache only; v3 has no live contract) | **STOP-AND-REPORT** + prepared design (B) |

No migration was applied. No GitHub variable was set. No workflow was dispatched. No provider
export/token was performed.

---

## D. LISTING HEALTH V3 — proposed CANONICAL LIVE contract (WORK D; DECISION-READY, NOT implemented)

Listing Health v3 today is a **shadow-only, read-only preview**: the scheduler writes `scheduler-v2/listing-health-v3`
shadows (100 at D-1 in prod), the UI tab is behind the default-OFF `LISTING_HEALTH_V3` flag, and `api/datadoe.js`
action `listing-health-v3` (`serveListingHealthV3Preview`) serves the SHADOW directly. There is **no** entry in
`SCHEDULER_LIVE_SNAPSHOT_CONTRACTS`, so there is no live promotion identity. The Listings/Raw reconciler (WORK C)
therefore rebuilds only the **validated shadow** and must NOT promote live until this contract is approved. This
section is the exact contract Codex must approve **before** LHv3 becomes a live-promoted, user-visible report.

| Field | Proposed value |
|---|---|
| Live report key (`liveReportKey`) | `listing-health-v3` (bare; the shadow stays `scheduler-v2/listing-health-v3`) |
| Live report version (`liveReportVersion`) | `listing-health-v3-shared-v1` (NEW; distinct from the shadow `snapshotVersion` `listing-health/v3-oli-window`) |
| Live params + params hash | `liveParams(shadowParams) = isCalendarDate(p.to) ? { to: p.to } : null`; `paramsHash = paramsHashFor("listing-health-v3-shared-v1", { to })` — a point-in-time as-of report, mirroring `brand-inventory` (to-only) |
| API / dashboard route identity | `api/datadoe.js` action `listing-health-v3` → switch `serveListingHealthV3Preview` to read the **live** row (`getReportSnapshot({ reportKey:"listing-health-v3", accountId, paramsHash })`) instead of the shadow, still capability-gated + behind `LISTING_HEALTH_V3`. **No new api/*.js** (reuse the existing action; count stays 12) |
| `validatePayload` | REUSE the existing strict LHv3 validator verbatim (accountId/asOf/rows[]/catalogBrands[]/currencies[]/issuesAvailable:boolean/window/coverage/salesWindowStatus/inventory/listingCount/issuesUnavailableReason/`salesSource==="order-line-items"`) |
| Source lineage requirements | REQUIRED: `order-line-items` (durable OLI) + `product-catalog` (durable) + **durable `listings`** (from WORK B `source_listings_snapshot`); OPTIONAL (degrade, never fail): `listing-health-v3:listings-raw` + `listing-health-v3:inventory`. `issuesAvailable:false` when optional raw/inventory absent — the existing contract, preserved |
| Shadow→live publisher mapping | Add `"listing-health-v3"` to `SCHEDULER_LIVE_SNAPSHOT_CONTRACTS`; the reviewed fenced `buildSchedulerV2Publisher` promotes the validated `scheduler-v2/listing-health-v3` shadow to the bare live key at the canonical hash (publisher-identical validation) |
| Readback identity | `buildLiveReadback({ reportKey:"listing-health-v3", liveReportKey:"listing-health-v3", accountId, paramsHash })` — canonical live identity + payload contract, exactly like every other live report |
| Relationship to Listing Health v1 | ADDITIVE. `listing-health` (v1) stays the default live page + its own live contract; v3 is a separate report behind `LISTING_HEALTH_V3`. **No v1 retirement or data cutover proposed here** |
| UI flag / cutover | `LISTING_HEALTH_V3` stays default OFF. Live serving is gated by the flag; promotion is gated by a NEW `LISTINGS_RECONCILE_LIVE` (or a dedicated `LHV3_PUBLISH_LIVE`) default-OFF variable. Cutover is flag-flip only; no forced migration of users |
| Rollback + LKG | Standard: fenced CAS (older never overwrites newer live), LKG preserved on every defer/failure; disabling the flag reverts serving to the shadow/v1; the live row is content-addressed so a bad promotion is superseded by the next validated one, never silently lost |

**What Codex must approve before LHv3 is user-visible:** (1) the new live report key + `listing-health-v3-shared-v1`
version + the to-only params contract; (2) adding `listing-health-v3` to `SCHEDULER_LIVE_SNAPSHOT_CONTRACTS`; (3) the
`api/datadoe.js` serve switch from shadow to live (behind the flag); (4) the durable Listings store (§A) being
finalized + applied FIRST (LHv3 live requires durable `listings` evidence); (5) the promote/UI cutover variable. Until
all five are approved, WORK C reconciles the LHv3 **shadow only** and performs shadow readback/validation, never live
promotion.
