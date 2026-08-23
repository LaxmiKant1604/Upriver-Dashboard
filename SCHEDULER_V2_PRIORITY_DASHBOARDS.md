# Scheduler v2 — Daily Reporting + Brand View "priority path"

Offline-implemented, operator-run path to bring **only** Daily Reporting (`daily-reporting`) and Brand View
(`brand-inventory`) live for the covered accounts by deriving them from the **already-proven durable OLI
history** + the organization **Catalog**, at a hard ceiling of **2 tokens** (one Catalog export) and **zero**
OLI / Ads / FBA / other-report exports. It requires no full bucket drain and enables no scheduler.

## Why this exists

A normal bucket sync derives the durable dashboards only after `globalDrained` — every planned source job must
terminalize: the trailing OLI rolling-refresh window, a per-account FBA export, Ads, and the Catalog. A read-only
drain-cost rehearsal on the live tree (2026-08-23) measured that a full drain for the 30 primary accounts needs
**~37 DataDoe creates** (≈ 6 OLI rolling-refresh + 1 org Catalog + 30 FBA) ≈ **74–185 tokens**, vs. the
authorized **2**. The durable OLI evidence for all 30 accounts is already complete and gapless (proven
separately); the only thing missing to *publish* the two dashboards is a derive, and a derive should not have to
pay for a full refresh. This path derives from what is already durable.

## What `priority` mode does (`run({ bucket, priority: true })`)

`lib/server/sync/source-bucket-sync-runtime.js` — `run()` gains a `priority` flag:

1. **Pauses every non-catalog source** (`order-line-items`, `fba-inventory-health`, all Ads, settlements, …),
   so the run plans **zero** OLI/Ads/FBA/other exports — structurally, not by configuration.
2. **Force-plans the Catalog family** (`forceCatalogRefresh`, threaded to `runBucketSourceSync` →
   `planBucketSourceSync` in `source-bucket-sync.js`) so a catalog-only cycle **drains** and the
   durable-evidence derive/save runs — even when the Catalog snapshot is already fresh (which would otherwise
   open no cycle and skip the derive). A warm Catalog cache makes this a zero-token reuse; a cold cache creates
   at most one export.
3. **Derives Daily Reporting + Brand View sales off the durable OLI history + Catalog.** The report lineage's
   OLI `depends_on` binds the durable `source_request_hash` (the provenance-binding path); Catalog `depends_on`
   binds this cycle's Catalog job hash. Fails closed for any account lacking durable OLI provenance.
4. **Represents missing Ads and FBA as UNAVAILABLE** via existing report contracts — Daily runs sales-only when
   Ads metrics are absent; Brand View inventory yields `inventoryAvailable: false` (empty table, `null` date)
   when there is no durable FBA snapshot, instead of skipping the account. Nothing is fabricated.

The normal (non-priority) behavior is byte-identical: `priority` defaults `false`, `forceCatalogRefresh`
defaults `false`, and the FBA-unavailable branch only changes behavior under `priority`.

## The trusted operator (`lib/server/sync/source-priority-dashboards.js`)

- `PRIORITY_DASHBOARDS` — frozen scope: `reportKeys = ["daily-reporting", "brand-inventory"]`,
  `buckets = ["us", "non-us"]`, `catalogSourceKey = "product-catalog"`, `maxCatalogCreates = 1`,
  `maxTokens = 2`.
- `makePriorityCreateGuard(inner, budget)` — wraps the DataDoe adapter so it may create **only**
  `product-catalog` exports, **at most one**, within a hard **2-token** ceiling shared across the whole run
  (both buckets share one `budget`). Any OLI/Ads/FBA/other create — or a second Catalog create / token overrun —
  **throws** (`PRIORITY_FORBIDDEN_CREATE` / `PRIORITY_TOKEN_CEILING`). Poll/download pass through. Defence in
  depth: `priority` already plans zero non-catalog jobs; the guard makes an out-of-contract create impossible.
- `buildPriorityDashboardsOperation({ buildRuntime, makeInnerAdapter, budgetMs })` — builds the real runtime
  with the guarded adapter and one shared budget; `deriveBucket(bucket)` runs `run({ bucket, priority: true })`.
  Run both buckets on the same operation to keep the one-Catalog-export / 2-token ceiling for the whole go-live
  (the non-US bucket reuses the org-scoped Catalog fetched for the US bucket).
- `assertPriorityPublishReportKey(reportKey)` — the publish allowlist: admits **exactly** `daily-reporting` +
  `brand-inventory`, refuses anything else, so an operator publish loop can never promote a paused report.

Publication itself stays operator-driven through the reviewed `buildSchedulerV2Publisher()` and its four gates
(code readiness → durable report enable → account rollout → explicit per-(report, account) approval), which are
opened and then closed around a one-time publish. `daily-reporting` is a Scheduler-v2 dispatch key (gated by
`report_sync_settings.schedule_enabled`); `brand-inventory` is the source-promoted Brand View (gated by
`source_promoted_publish_settings.publish_enabled`). This module **never** enables the scheduler, never sets
`all_primary`, and never publishes any other report.

## Regressions

- `scripts/source-priority-dashboards.test.js` (P1–P5): the create guard (catalog-only, ≤1 create / ≤2 tokens,
  shared budget, poll/download pass-through), the publish allowlist, the bucket **plan** for all 30 covered
  accounts (8 US + 22 non-US) proving **zero** OLI/FBA jobs and exactly **one** Catalog job per bucket (with a
  contrast test showing a normal plan *would* export OLI + FBA), the operation wiring (priority=true + shared
  budget refusing a second Catalog export), and the Brand View inventory-unavailable contract.
- `scripts/source-production-hardening.test.js` (F11a–F11e): the **real-runtime** proof against
  `buildBucketSourceSyncRuntime` — 30 covered accounts derive Daily + Brand View off durable OLI + Catalog with
  exactly one Catalog export and **zero** OLI/Ads/FBA creates; missing FBA → `inventoryAvailable: false`;
  `priority` forces a Catalog job even when the snapshot is fresh (so the derive runs); fails closed on missing
  OLI provenance; and only `product-catalog` jobs appear in the owning cycle.

`npm run verify` (57 steps / 37 suites, incl. `build:check`) is green.

## Operator run (deferred — do NOT run in production before Codex sign-off)

1. Confirm ≥2 DataDoe tokens (read-only balance check).
2. For each bucket in `["us", "non-us"]`, on ONE `buildPriorityDashboardsOperation` instance:
   `preflightEvidence` → `deriveBucket(bucket)`; assert `budget.tokens ≤ 2` and zero non-catalog creates
   throughout.
3. Open the publisher gates for `daily-reporting` + `brand-inventory` only, publish the validated snapshots for
   the covered accounts (guarded by `assertPriorityPublishReportKey`), verify each live snapshot, then close the
   gates (revoke approvals, disable rollout, restore `report_sync_settings` baseline).
4. Frontend-verify `GET /api/datadoe?action=daily&…` and `GET /api/datadoe?action=brand-inventory&…`.
5. Keep every other report paused; keep the scheduler disabled (`all_primary=false`, no cron). Stop for Codex
   review before any scheduler enablement.
