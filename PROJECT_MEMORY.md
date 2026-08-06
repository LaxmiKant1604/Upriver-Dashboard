# Project Memory

## Scheduler v2 Phase 1b operational contracts approved (Codex, 2026-08-06)

Final review of commits `5afd393` and `ab5d31a` on
`feature/scheduler-v2` found no remaining contract-layer issue. Availability policies
now enforce exactly `terminal -> blocked` and
`degraded -> save-unavailable-snapshot`; crossed pairs fail closed through both
normalization and `sourceDisabledOutcome()`. The earlier strict-cap, immutable concrete
job policy, typed SQP fallback, five-ID batching, keyed windows, and primary/secondary
organization isolation corrections remain intact. The pinned request hash is unchanged.

`npm run verify` passed: 54 insight + 60 Brand View + 23 sync + 6 source-cache +
22 Scheduler v2 + 7 source-identity + 85 report-contract assertions + production
build. Phase 1b's currently declared operational-report contract foundation is
**approved**. Next work is the separately reviewable declaration/parity-test pass for
the remaining six insight reports; Phase 1c must still wait until those declarations
are reviewed. Live gates remain Daily superset-vs-compact reconciliation and controlled
per-organization probes for SQP/content/listings availability. No push, merge,
deployment, migration, insight declaration, or Phase 1c work was performed in this
approval review.

## Scheduler v2 Phase 1b — availabilityPolicy pair consistency fixed (2026-08-06)

Fixed the final policy-consistency finding (below) on `feature/scheduler-v2` (not
pushed/merged/deployed; `feature/design-system` untouched; no insight contracts; Phase
1c NOT started; no migration). Commit `5afd393` (code + tests) + a docs commit.

- `normalizeAvailabilityPolicy()` validated `disabledSource` and `reportOutcome`
  independently, accepting contradictory pairs. It now enforces the ONLY two valid
  pairs — **terminal → blocked**, **degraded → save-unavailable-snapshot** — after the
  existing enum / non-empty-safeCode / no-HTTP-424 checks; a crossed pair
  (terminal + save-unavailable-snapshot, degraded + blocked) throws. `null` → null.
- `sourceDisabledOutcome()` now consumes `normalizeAvailabilityPolicy()`, so both
  enforce exactly the same invariant (contradictory policy fails closed in both; null is
  treated conservatively as terminal/blocked).
- No `request_hash`/identity change (policy is outside the DataDoe request; golden hash
  `5601253219be13c7…` unchanged). No fallback-behaviour change.
- `report-source-contracts.test.mjs` = **85 assertions** (adds valid-pair accept +
  crossed-pair reject in both functions, and the null=>blocked case). Full `npm run
  verify` green; `git diff --check` clean.

## Scheduler v2 Phase 1b re-review - final policy consistency fix required (Codex, 2026-08-06)

Reviewed commits `724f502` and `0f55f4b` on `feature/scheduler-v2`. The
resolved jobs now preserve immutable `strict` and `availabilityPolicy` execution
metadata without changing request hashes, and typed fallback signals correctly avoid
monthly SQP after failed/terminal/unvalidated weekly results. Full `npm run verify` is
green (54 insight + 60 Brand View + 23 sync + 6 source-cache + 22 Scheduler v2 +
7 source-identity + 83 report-contract assertions + build).

One contract-validation issue remains before Phase 1b approval:
`normalizeAvailabilityPolicy()` validates `disabledSource` and `reportOutcome`
independently, so it accepts contradictory pairs such as
`terminal + save-unavailable-snapshot` and `degraded + blocked`. These resolve to
conflicting worker instructions (`blocks:true` while asking to save, or `blocks:false`
while reporting blocked). Enforce the only valid pairs: terminal -> blocked and
degraded -> save-unavailable-snapshot; make `sourceDisabledOutcome()` consume the same
normalized invariant; add focused rejection tests. No insight declarations, Phase 1c,
push, merge, deployment, or migration was performed in this review.

## Scheduler v2 Phase 1b re-review corrections — applied (2026-08-06)

Fixed the two re-review findings (below) on `feature/scheduler-v2` (not
pushed/merged/deployed; `feature/design-system` untouched; insight declarations +
Phase 1c NOT started; no migration). Commits `724f502` (code + tests) + a docs commit.

- **FIX 1 — execution policy on concrete jobs.** `reportSourceRequestHashes()` jobs now
  carry `strict` (explicit boolean) and `availabilityPolicy` (null, or a frozen
  `{ disabledSource, safeCode, reportOutcome }` from the new `normalizeAvailabilityPolicy`,
  which copies + validates enums, rejects HTTP-status strings, and detaches from
  `REPORT_SOURCE_CONTRACTS`). Docstring updated. request_hash is unchanged (metadata is
  not part of the DataDoe request). Concrete job shape recorded in SCHEDULER_V2.md §9.
- **FIX 2 — typed validated fallback signal.** Ended the `null == 0 periods` conflation.
  `evaluateFallbackCondition` requires a typed signal `{ status:
  "success"|"last-known-good"|"failed"|"terminal", validated: boolean,
  distinctPeriods: number|null }`. Only a VALIDATED fresh/last-known-good weekly under
  the threshold schedules monthly; failed/terminal/unvalidated does NOT (prior report
  preserved, no wasted export). Fails closed: malformed signal / unsupported condition /
  invalid threshold or period count throw. Full state table in SCHEDULER_V2.md §9;
  earlier §8's "failed weekly still attempts monthly" line is corrected.
- `report-source-contracts.test.mjs` = **83 assertions** (adds execution-policy fields,
  registry-immutability, request_hash-unchanged, the full typed-signal table, and
  fail-closed cases). Full `npm run verify` green; `git diff --check` clean.
- Remaining live gates unchanged: Daily all-brand reconciliation, per-org SQP/content/
  listings-raw availability. Insight contracts + Phase 1c remain future work.

## Scheduler v2 Phase 1b re-review - two corrections still required (Codex, 2026-08-06)

Reviewed commits `625001f`, `4d1dd64`, and `7afb323` on
`feature/scheduler-v2`. The Daily monthly row-cap guard is correctly placed before
append/derivation, the Keyword monthly declaration is no longer unconditional, and
HTTP 424 prose was replaced with structured source-disabled policies. Full
`npm run verify` is green (54 insight + 60 Brand View + 23 sync + 6 source-cache +
22 Scheduler v2 + 7 source-identity + 74 report-contract assertions + build).

Phase 1b is nevertheless **not approved yet** because:

1. `reportSourceRequestHashes()` drops execution semantics from its returned concrete
   jobs. It does not return `strict` or `availabilityPolicy`, although Phase 1c is
   expected to enforce those fields and the function documentation/tests claim each
   result carries everything the worker needs. Return immutable execution metadata
   (at least strict + availability policy), test it on strict/terminal/degraded jobs,
   and make the worker contract explicit before Phase 1c.
2. The fallback signal conflates a failed weekly source (`null`) with a successful
   zero-period weekly result. A data-dependent fallback must run only from a validated
   fresh or last-known-good weekly payload. A failed weekly fetch with no validated
   payload must preserve the prior report and must not spend a monthly export merely
   because `null` is interpreted as zero. Use a typed signal carrying validation/status
   and period count; test success-empty, validated last-known-good, terminal-disabled,
   and failed-without-last-known-good separately. Unsupported fallback condition types
   should fail closed rather than silently return false.

No insight declarations, Phase 1c work, push, merge, deployment, or Supabase migration
was performed during this re-review.

## Scheduler v2 Phase 1b review blockers — fixed (2026-08-06)

Fixed the three implementation blockers from "Phase 1b review - changes required"
(further below) on `feature/scheduler-v2` (not pushed/merged/deployed;
`feature/design-system` untouched; insight declarations + Phase 1c NOT started; no
migration). Commits `625001f` (FIX 1) + `4d1dd64` (FIX 2+3) + a docs commit. Blocker
4 (insight dedup/classification doc) was already corrected in `SCHEDULER_V2.md` §7
during review.

- **FIX 1 — Daily superset strict cap (blocker 2).** `fetchDailyBrandSalesRows`
  (api/datadoe.js) now rejects any monthly ASIN/day window at `DAILY_BRAND_ROW_LIMIT`
  (50000) **before appending** (window in the safe error), so a truncated month can't
  derive/save an understated all-brand/named-brand total. `strict: true` added to
  every contract whose builder truly enforces the cap (daily superset, sku-pl, keyword
  weekly+monthly, reconciliation orders+settlements) and none that don't; pure
  `rejectsAtCap(rowCount, limit)`. Tests: 49,999 accepted / exactly 50,000 rejected;
  builder guard precedes append; no unbacked `strict` label. Daily stays behind its
  live superset-vs-compact reconciliation gate.
- **FIX 2 — Keyword monthly typed fallback (blocker 1).** `keyword-rank:sqp-monthly`
  now has `dependencyMode:"fallback"`, `dependsOnRequestKey:"keyword-rank:sqp-weekly"`,
  `condition:{type:"distinct_periods_lt",value:4}`. Pure `evaluateFallbackCondition`
  + resolver `fallbackSignals`: monthly is active ONLY once weekly is evaluated (signal
  present) AND has <4 distinct periods. **Token saving:** kickoff plans no monthly, so
  sufficient weekly history spends no monthly export (one fewer/account/cycle). A
  present-but-empty weekly signal (failed/last-known-good) still attempts monthly.
  Deterministic; one-create-export-per-cycle stays `unique(cycle_id, request_hash)` +
  `claim_source_export_attempt`. Tests: kickoff no-monthly, 4+ => none (+ rejects stray
  monthly window), 0-3 => exactly one, no duplicate, last-known-good failure still
  attempts monthly, org isolation, 0/1/5/6/11 transport parity.
- **FIX 3 — machine-readable failure policy (blocker 3).** Replaced the misleading
  `orgAvailability` strings (which described the report API's HTTP 424) with structured
  `availabilityPolicy {disabledSource:"terminal"|"degraded", safeCode:"SOURCE_DISABLED",
  reportOutcome:"blocked"|"save-unavailable-snapshot"}` on every conditional source
  (keyword weekly+monthly, content events — all terminal). Pure `sourceDisabledOutcome`
  branches on this, never on HTTP 424 (no contract field contains "424"). Tests: every
  conditional source has structured policy; terminal vs degraded distinct; degraded
  permits derivation; terminal blocks only its report.
- `report-source-contracts.test.mjs` = **74 assertions**; full `npm run verify` green.
  Remaining live gates: Daily all-brand reconciliation, per-org SQP/content/listings-raw
  availability. Insight contracts + Phase 1c remain future work.

## Supabase plan and storage status (2026-08-06)

- The `upriver-shared-data` Supabase project is managed through the Vercel
  Marketplace. Subscription changes, invoices, and payment must therefore be handled
  in Vercel; the Supabase dashboard's direct plan controls are intentionally disabled.
- Supabase usage showed database size `607 MB / 500 MB`, so the Free database quota
  has been exceeded. The intended upgrade is Supabase Pro through the existing Vercel
  Marketplace installation; the displayed Pro allowance is 8 GB disk per project.
- On Pro, general-purpose database disk beyond the included 8 GB is billed at the
  current Supabase rate of `$0.125/GB/month` (prorated by GB-hour). Paid-project disks
  auto-expand near 90% utilization when overage/spend settings permit it; file-object
  storage is a separate quota and charge. Current 607 MB database usage needs no
  additional database-disk purchase after the Pro upgrade.
- This is separate from the Vercel hosting plan. Upgrade the Supabase Marketplace
  resource, not merely the Vercel application hosting plan.
- Architecture recommendation: direct Supabase management is preferable long-term for
  the planned SaaS because billing, owners, project creation, and provider features are
  controlled independently of Vercel. Do not transfer during Scheduler v2 development;
  upgrade through Vercel now, stabilize/validate Scheduler v2, then plan and test a
  Vercel-managed-to-Supabase-managed organization transfer separately. No transfer
  decision or action has been made yet.

## Scheduler v2 Phase 1b review - changes required (Codex, 2026-08-06)

Reviewed commits `86cc805` and `7a8c8f4` on `feature/scheduler-v2`. Full
`npm run verify` is green (54 insight + 60 Brand View + 23 sync + 6 source-cache
+ 22 Scheduler v2 + 7 source-identity + 60 report-contract assertions + build),
but Phase 1b is **not approved yet**. Tests currently miss the following semantic
and operational issues:

1. **Keyword monthly fallback wastes a source export.** The executable handler only
   fetches monthly SQP when weekly has fewer than four periods. The declaration makes
   weekly and monthly unconditional, spending one unnecessary monthly export per
   account/cycle once weekly history is sufficient. Encode a data-dependent fallback
   condition that Phase 1c can enforce; do not solve this by browser input.
2. **Daily superset truncation is not actually guarded.** The declaration and test
   call the 50,000-row monthly cap "strict", but `fetchDailyBrandSalesRows` uses
   `fetchExportRows` and never checks `rows.length >= DAILY_BRAND_ROW_LIMIT`. A capped
   month could therefore derive understated all-brand and brand totals. Add an
   executable strict guard or explicit scheduler validation metadata/output with a
   test that fails if the guard disappears. Keep Daily behind its live superset-vs-
   compact reconciliation gate.
3. **Disabled-source status is described at the wrong layer.** HTTP 424 is generated
   by the user-facing report API. A source-first worker sees DataDoe's raw disabled-
   source error. Contracts must expose machine-readable terminal/degraded semantics;
   Phase 1c must not branch on the report API's HTTP 424 string.
4. **Insight dedup/classification documentation was inaccurate.** Five reports share
   `common.fetchCatalog`, not all six; only three share the inventory helper. Listing
   Optimizer uses a richer catalog identity, so it cannot share that common catalog.
   Its disabled SQP path degrades to a valid `sqpAvailable:false` snapshot rather than
   making the whole report terminal. `SCHEDULER_V2.md` was corrected during review.

No implementation correction, Phase 1c work, push, merge, deployment, or Supabase
migration was performed in this review. The next Claude pass must correct these four
items, add focused tests, update both documents, and return for re-review before any
insight declarations or worker implementation continue.

## Scheduler v2 Phase 1b — operational reports complete + insight audit (2026-08-06)

`feature/scheduler-v2` (not pushed/merged/deployed; `feature/design-system` untouched;
Phase 1c NOT started; no migration applied). Commit `86cc805` + a docs commit.

**Completed contracts this session (`86cc805`, parity-tested vs executable `api/datadoe.js`):**
- **Daily Reporting — now COMPLETE** via a scheduler-owned superset strategy. Fetch the
  ASIN/day Sales & Traffic SUPERSET once per account (`fetchDailyBrandSalesRows`: already
  monthly-segmented, `child_asin` grain, `DAILY_BRAND_ROW_LIMIT` 50000) +
  `daily-reporting:catalog` once, and DERIVE the all-brand total (sum over child_asin per
  date) AND every named brand (ASIN→brand via catalog). **No per-brand export, no compact
  all-brand export** — the compact date-grain export is a strict roll-up of the superset
  (same source 401ffcd7e5 + same aggregations, coarser grouping). Request keys:
  `daily-reporting:asin-day-superset`, `daily-reporting:catalog`. Ads derived from
  `ads_daily_source_rows`. `REPORT_DERIVATION` records the strategy; LIVE GATE = reconcile
  superset-summed all-brand vs the compact total once. Corrected
  `REPORT_SOURCE_REQUIREMENTS["daily-reporting"]` to include `product-catalog`.
- **Keyword Rank — COMPLETE.** `keyword-rank:sqp-weekly` (84d) + `:sqp-monthly` (365d) +
  `:catalog` (365d). SQP = raw rows, date/ASC, 50000, strict truncation. Scheduler fetches
  BOTH cadences unconditionally (deterministic; documented +1 monthly export/account vs the
  browser's weekly<4 fallback). `orgAvailability` records HTTP 424 terminal status.
- **Content Changes — COMPLETE.** `content-changes:events` = NO-DATE export (from/to null,
  event_time/DESC, 1000) + `:catalog` (365d). `orgAvailability` = HTTP 424 terminal.
- `REPORT_SOURCE_COVERAGE` now: brand-sales, sku-pl, reconciliation, fba-plan,
  daily-reporting, keyword-rank, content-changes = **complete**. Tests: `test:report-contracts`
  = 60 assertions; `npm run verify` green.

**Insight reports — audited + classified (contracts NOT declared this session).** Every
source call was read from `lib/server/reports/*.js` (`sources.js` + `common.js` +
per-report builders). Classification (owned = report's own DataDoe export; derived =
persisted/other snapshot; org-cond = defaultDataset:false ⇒ HTTP 424):
- **Sales Movers** — all OWNED: `sales-traffic` (TRAFFIC_COLUMNS, per current+prior window),
  `profit-by-sku` (ad metrics: ADS_COLUMNS), `fba-inventory-health`, `product-catalog`.
  (Ads come from Profit-by-SKU, NOT the persisted ads sources.)
- **Buy Box Loss** — all OWNED: `profit-by-sku` (DAILY_COLUMNS, per slice), `fba-inventory-health`,
  `product-catalog`.
- **Returns & Refunds** — all OWNED: `returns`, `settlements`, `sales-traffic`, `product-catalog`.
- **Listing Health** — OWNED + org-cond: `listings` (no-date), `profit-by-sku`,
  `fba-inventory-health`, `product-catalog`, and **`listings-raw` (org-conditional, DEGRADES
  gracefully when disabled — optional)**.
- **Listing Optimizer** — OWNED + org-cond: `sqp-weekly` (org-conditional, terminal if
  disabled) + `product-catalog`.
- **PPC Performance** — OWNED small `sales-traffic` (["date"] rollup, 500, TACoS denominator)
  + `product-catalog`; **ads are DERIVED from persisted `ads_daily_source_rows`** (never a
  live ads export).
- Priority Feed + Brand View remain derived-only (no DataDoe export).
- **Token-saving finding:** the insight reports share `fetchCatalog` (product-catalog, no-date,
  limit **20000**, child_asin/ASC) and `fetchInventorySnapshot` with IDENTICAL request
  identities, so the scheduler dedups them to ONE catalog + ONE inventory export per account
  across all insight reports. NOTE the insight catalog (no-date, 20000) has a DIFFERENT
  request_hash than the operational reports' catalog (windowed, 10000) ⇒ not shared with them.

**Why insight contracts were NOT declared this session (stop condition):** each insight report
composes 3–5 report-specific column sets (in the builder files, not `api/datadoe.js`) plus
shared fetchers and org-conditional sources; accurate per-call transcription + parity testing
for 6 reports is the next focused increment. The classification above is complete; formal
`REPORT_SOURCE_CONTRACTS` entries + parity tests remain. No guessing was committed.

**Remaining:** declare the 6 insight contracts (owned calls, with the same parity-tested method,
reading each builder's column constants); then Phase 1c. Live DataDoe reconciliation
(incl. the Daily all-brand superset equality + org 402/404/424) remains Codex's gate.


## Scheduler v2 Phase 1b - Daily/FBA/Reconciliation contracts (2026-08-06)

Continued `feature/scheduler-v2` only. Nothing was pushed, merged, deployed, or
applied to Supabase; `feature/design-system` was not touched; Phase 1c was not
started. Commits: `a53b3e2` (empty-scope ordering), `f2eb3e5` (contracts/tests),
plus the documentation commit that records this section.

- `reportSourceRequestHashes` now returns `[]` for an empty account scope before
  window or conditional-marketplace validation. An account resolving to no raw
  DataDoe IDs therefore creates no source job and cannot fail on irrelevant input.
- Declared **Reconciliation** from the executable builder: monthly Order Line Items
  and monthly Settlements (six separate windows, 50,000-row limit, date ASC), plus
  one full-range Product Catalog request. Windows stay bound to their request keys;
  there is no Cartesian multiplication.
- Declared **FBA Shipment Plan** from the executable builder: Sales & Traffic units
  by ASIN for 3 completed months + current MTD, a separate current-month date probe,
  Product Catalog, FBA Inventory Health, and US-only no-date Listings/AWD. The two
  Sales & Traffic calls have different columns and therefore different request
  hashes even when their dates match.
- AWD applicability is driven by authoritative account marketplace metadata. A US
  plan must include the AWD request; a non-US plan cannot include it; missing country
  metadata fails contract resolution rather than silently losing AWD. Empty scopes
  still return before this validation.
- Declared only the **all-brand Daily Reporting** path: Sales & Traffic by account/day.
  Ads are an explicit derived dependency on persisted `ads_daily_source_rows`, so
  Daily does not own another Ads export in scheduled mode. The named-brand path uses
  ASIN/month Sales & Traffic plus Product Catalog and remains undeclared. Coverage is
  marked `all-brand-only`, so Phase 1c must not enable Daily as fully migrated yet.
- Source coverage tests now require report-owned plus explicitly derived source keys
  to exactly cover `REPORT_SOURCE_REQUIREMENTS`; this distinguishes intentional reuse
  from an omitted source. FBA's country-conditional source and every report request
  key are also validated.
- Verification from this worktree: `npm run verify` passed 54 insight + 60 Brand View
  + 23 sync + 6 source-cache + 22 Scheduler v2 + 7 source-identity + 46 report-contract
  assertions and the complete production build. `git diff --check` was clean.
- Remaining Phase 1b: named-brand Daily, Keyword Rank, Content Changes, and all
  insight report contracts. Live DataDoe source availability, 402/404 behavior, real
  request-hash reconciliation, and live Postgres concurrency remain rollout gates.

## Scheduler v2 Phase 1b — resolver correction: 5-ID chunking + keyed windows (2026-08-06)

Corrected the two resolver findings from Codex's Phase 1b review on
`feature/scheduler-v2` (not pushed/merged/deployed; `feature/design-system`
untouched; Phase 1c NOT started; no new report declarations added). Commits
`c46deef` (batching leaf) + `9877e21` (resolver + tests) + the docs commit.

- **Exact five-ID batching (`c46deef`, `9877e21`).** The live transport
  (`fetchExportRows`) chunks the account scope into groups of
  `MAX_SELLER_OR_VENDOR_IDS_PER_EXPORT = 5` in input order and computes one identity
  per chunk. The resolver previously hashed ALL IDs together — wrong. Extracted the
  batching into a dependency-free leaf `lib/server/id-batching.js` (`MAX…`,
  `chunkArray`, `chunkAccountIds`); `datadoe.js` imports + re-exports it (so
  `api/datadoe.js` is unaffected) and the resolver imports it, so both chunk
  identically. `reportSourceRequestHashes` now emits **one request per 5-ID chunk**
  with its own `request_hash`; empty scope ⇒ `[]`. Each result carries
  `sellerOrVendorIds` (the exact chunk) plus requestHash / organizationFingerprint /
  accountScopeHash / requestMeta / requestKey / sourceKey / sourceId / from / to /
  limit / options.
- **Contract-specific windows (`9877e21`).** Removed the global behaviour that applied
  every window to every source (a Cartesian product). Each declared source now has a
  stable **requestKey** (`brand-sales:order-lines`, `brand-sales:catalog`,
  `sku-pl:monthly-profit`); windows come in as `windowsByRequestKey` and are applied
  only to their own key. Missing or unknown request keys throw. This lets the future
  FBA Plan sources independently take monthly sales windows, a catalog range, an
  inventory snapshot range, and no-date Listings with no accidental cross-products.
- **Tests (`9877e21`, 23 assertions).** ID counts 0/1/5/6/11 reproduce the transport's
  chunks + hashes (independently chunked with the same leaf + shared identity); 6 IDs
  ⇒ two chunks per source, 11 ⇒ three; each result carries its exact chunk; chunk
  boundaries follow input order while within-chunk reordering keeps the hash; empty
  IDs ⇒ none; per-key windows with no cross-product; a no-date request never gets
  another source's dates; missing/unknown keys throw; primary vs dd-secondary stay
  isolated; plus the executable-parity checks vs `api/datadoe.js`.
- `npm run verify` green: 54 insight + 60 Brand View + 23 sync + 6 source-cache + 22
  scheduler-v2 + 7 source-identity + 23 report-contracts + build. `node --check`,
  `test:source-identity`, `test:report-contracts`, `git diff --check` all clean. No
  live DataDoe probe; live reconciliation against a real export remains Codex's gate.

## Scheduler v2 Phase 1b — identity extraction + first source contracts (2026-08-06)

Codex approved the corrected foundation; started Phase 1b on `feature/scheduler-v2`
(not pushed/merged/deployed; `feature/design-system` untouched; Phase 1c NOT started).
Small commits `420101b`, `5026038`.

- **Byte-identical extraction (`420101b`).** `sourceRequestIdentity` (+`sha256`,
  `stableValue`) moved VERBATIM out of `lib/server/datadoe.js` into
  `lib/server/source-identity.js` (a clean leaf importing only `source-contracts.js`);
  `datadoe.js` now imports it, and its now-unused `createHash`/`sourceContractForId`
  imports were dropped. The algorithm is unchanged — org fingerprint, account scope
  joined with **U+001F** (a raw control char that slipped in was replaced with the
  `\u001f` escape; runtime value identical), contract-key source, sorted columns,
  from/to, limit, sorted groupBy, sorted aggregations, orderBy. `source_export_cache`
  stays valid. Proven by `scripts/source-identity.test.mjs` (7 assertions): parity vs
  an independent reconstruction of the pre-extraction code across a battery of inputs,
  a pinned golden `request_hash` (`5601253219be13c7…`), canonical ordering,
  contract-key resolution, org + account-scope isolation, and window/columns/limit/
  ordering sensitivity.
- **Per-report contracts (`5026038`).** `lib/server/sync/report-source-contracts.js`
  declares each report's exact create-export inputs and `reportSourceRequestHashes()`
  to resolve `request_hash`es via the shared identity. Declared + parity-tested
  against the executable `api/datadoe.js` constants (`scripts/report-source-contracts.test.mjs`,
  10 assertions — a mis-transcribed column/limit fails the suite): **brand-sales**
  (Order Line Items + Product Catalog over one shared window) and **sku-pl** (Profit
  by SKU & Date, per-month). Org isolation (primary vs dd-secondary apiKey => different
  hash), deterministic dedup, and account/window sensitivity are all asserted.
- **Deliberately NOT declared** (avoids assumptions): the multi-call/per-month/
  brand-variant reports (`daily-reporting`, `fba-plan`, `reconciliation`,
  `keyword-rank`, `content-changes`) and the insight reports. Auditing showed several
  reports fire multiple exports with per-month windows and brand-variant columns, and
  the same `source_id` across two reports usually differs by window ⇒ different
  `request_hash` ⇒ not a shared export. These are the next Phase 1b increment, same
  parity-tested method.
- `npm run verify` green: 54 insight + 60 Brand View + 23 sync + 6 source-cache + 22
  scheduler-v2 + 7 source-identity + 10 report-contracts + build. No live DataDoe
  probe was run; live request_hash reconciliation against a real export remains Codex's
  gate.

## Scheduler v2 test file renamed to a fresh path (2026-08-06)

Codex approved the corrected SQL invariants + source dependency map, but
`scripts/test-scheduler-v2.mjs` was still an inaccessible filesystem entry in the
Codex checkout (`node --check`, direct read, and `git mv` all timed out on that
path). Fixed the artifact only — no logic change, Phase 1b still not started.

- The committed 22-assertion content was preserved verbatim under a NEW filename
  **`sales-dashboard-live/scripts/scheduler-v2.test.mjs`**; the old
  `scripts/test-scheduler-v2.mjs` was removed (`git rm`) and is not recreated.
  `package.json` `test:scheduler-v2` now runs the new path. Git records it as a
  clean rename (identical content).
- Old path confirmed gone: `test -e …/test-scheduler-v2.mjs` → removed;
  `git ls-files` shows no file of that name.
- **Exact results from the checked-out worktree (this environment):**
  - `node --check scripts/scheduler-v2.test.mjs` → exit 0
  - `npm run test:scheduler-v2` → `22 assertions passed`, exit 0
  - `npm run verify` → 54 insight + 60 Brand View + 23 sync + 6 source-cache + 22
    scheduler-v2 + build, exit 0
  - `git diff --check` → clean, exit 0
- Note: the original hang was never reproducible in this workspace, so this is a
  filesystem-entry workaround (fresh path + fresh bytes), not a proven root-cause
  fix. Codex must re-run the four commands above against its own checkout.
  Commit: see the rename commit below. Not pushed/merged/deployed;
  `feature/design-system` untouched.

## Scheduler v2 foundation — review corrections applied (2026-08-07)

Addressed all four blocking items from "Scheduler v2 foundation review (Codex,
2026-08-05)" on `feature/scheduler-v2` (still not pushed/merged/deployed;
`feature/design-system` untouched at `e90c268`). Small local commits `549679e`
(migration), `6352d90` (tests), + the docs commit.

1. **DB one-attempt invariant (fixed, `549679e`).** The permissive CHECK is gone.
   `20260807_scheduler_v2.sql` now enforces, at the database, the only two legal
   states: `check ((create_export_count = 0 and attempted_at is null) or
   (create_export_count = 1 and attempted_at is not null))` — a second create-export
   cannot be recorded even by a direct service-role write. `claim_source_export_attempt`
   remains a single atomic guarded UPDATE (`where attempted_at is null; return found`),
   so concurrent/repeated calls never increment past one.
2. **Cycle timing (fixed, `549679e`).** `open_sync_cycle` is enqueue-only: creates an
   idempotent `pending` cycle with `started_at` NULL; repeated kickoff/watchdog calls
   return it unchanged. New `claim_sync_cycle(cycle_id)` atomically moves
   `pending -> running` and stamps `started_at` once (`where status='pending'; return
   found`) — cannot be claimed twice or restarted. `scheduled_at` (target) and
   `started_at` (actual) are separate for truthful Admin timings.
3. **Source map (corrected from executable code, in `SCHEDULER_V2.md` §3).** From
   `api/datadoe.js`: `brand-sales` (`buildBrandSalesPayload`, L622) uses
   **Order Line Items `89b27535…` + Product Catalog `68d2de…`**, NOT Sales & Traffic;
   FBA velocity + Daily use **Sales & Traffic `401ffcd7e5`** (`PLAN_SALES_SOURCE_ID`
   L778 / `DAILY_SALES_SOURCE_ID` L675); `b24cd69c06` is a separate legacy path.
   Added the rule that the same `source_id` does NOT imply a shared export — dedup
   requires the *complete* request identity (org, scope, source, columns, grain,
   aggregations, window, limit, ordering) to match, which per-report windows usually
   do not; insight-report contracts remain unaudited (marked for Phase 1b + live).
4. **Test blocker (fixed, `6352d90`).** Recreated `scripts/test-scheduler-v2.mjs` with
   static imports / no top-level await / ASCII only (the top-level `await import(...)`
   was the likely hang cause; could not reproduce the hang here, so removed the most
   likely differentiator). Verified from the checked-out worktree: `node --check`
   exits 0, `npm run test:scheduler-v2` = **22 assertions passed**, full `npm run
   verify` green (54 insight + 60 Brand View + 23 sync + 6 source-cache + 22
   scheduler-v2 + build), `git diff --check` clean.

**Remaining live gaps (Codex):** real non-US & US cycles across both DataDoe orgs;
the one-attempt/cycle-claim invariants under *actual* Postgres concurrency (modelled
+ structurally asserted here, not executed against a live DB); the non-Indian 402/404
per-org source probe; and the Phase 1b+ implementation. Phase 1b stays blocked pending
Codex approval of this corrected foundation.

## Scheduler v2 — source-first sync, foundation started (2026-08-07)

Branch **`feature/scheduler-v2`** from `origin/main` @ `330ac91` (NOT pushed/merged/
deployed; `feature/design-system` left untouched at `e90c268`). Full working design,
source dependency map, phased plan and rollout in **`SCHEDULER_V2.md`** (repo root) —
read it first. No live DataDoe/Supabase/browser here, so every real-cycle / 402-404 /
"page renders" claim is Codex's live gate, never asserted from this workspace.

**Investigation (verified from code).** Scheduler **v1** already exists and is
deployed: `registry.js` (only 4 Ads + `brand-sales` enabled; the legacy 7 + insights
declared `enabled:false` — that is why pages still show "Refresh from DataDoe"),
`run-sync.js`, `planner.js`, adapters, `20260805_scheduled_sync.sql`, and
`20260806_shared_source_export_cache.sql`. **The canonical source identity already
exists** in `datadoe.js` `sourceRequestIdentity` → `request_hash =
sha256({organizationFingerprint, accountScopeHash, requestMeta{source, columns,
from, to, limit, groupBy, aggregations, orderBy}})`, and `fetchSourceChunk` dedups
(memory + in-flight + `source_export_cache`) and rejects truncated results. The v2
gap: no durable *cross-invocation* one-create-export-per-request_hash-per-cycle
guarantee, no source→report dependency graph, no separated fetch/derive/save state.

**Landed this session (verify-green, small commits):**
- `0563d3e` — additive migration `20260807_scheduler_v2.sql`: `sync_cycles`
  (unique(bucket, cycle_date)), `sync_source_jobs` (unique(cycle_id, request_hash);
  `attempted_at` + `create_export_count<=1` durable one-POST guard; safe error
  code/stage/message; row_count/bytes/duration/terminal; last-known-good refs),
  `sync_report_jobs` (separate fetch/derive/save + `validated`; latest_data_date;
  snapshot ref). RPCs `open_sync_cycle` (idempotent) + `claim_source_export_attempt`.
  RLS service-role-write / admin-read. **No secret in any migration.**
- `4469e70` — planner v2 pure core (`buildDependencyPlan` dedup,
  `sourceExportAttemptAllowed`, `reportFetchGate`) + `scripts/test-scheduler-v2.mjs`
  (10 assertions in `npm run verify`: dedup=1 export, one-attempt, no-re-POST,
  last-known-good derive gate, schedules 02:00/10:30, migration additive + no-secret).

**Remaining (staged, see SCHEDULER_V2.md §4):** 1b registry per-report source
contracts (+ extract `sourceRequestIdentity` into a shared module, byte-identical
hash); 1c checkpointable worker/run-sync v2; 1d derivation adapters consuming saved
source rows; 1e Admin Data Sync Center (view + `/api/admin/sync.js` + sidebar,
admin-only, no manual-refresh button); 1f pg_cron/pg_net kickoff (separate migration,
Vault secret, applied after load); **Phase 2 last** = remove manual refresh from
App.jsx + new empty states + server rejects `refresh=1`. Non-Indian 402/404 needs one
controlled per-org source probe. Deploy backend + validate real non-US & US cycles
(both orgs) BEFORE the refresh-removal UI.

## DataDoe support guidance reviewed (2026-08-04)

- DataDoe confirmed that large report pulls should use its **REST API**, not MCP: MCP exports are capped at 3,500 rows each and a large result is split into multiple token-consuming exports, whereas one REST API export can return up to the requested large file size as a single export. Upriver already uses server-side REST API exports, so this architecture is the correct token-saving path; do not replace it with MCP report loops.
- DataDoe corrected an MCP result-limit defect from 25 to 250. This does not change the dashboard's API integration.
- Initial source loading/backfills can take 24-48 hours, and slower report families such as inventory may be queued after sales/orders. Treat missing or delayed upstream rows as incomplete DataDoe sync state, never as zero sales or zero inventory.
- Support said Amazon Sales & Traffic reporting can be delayed/restricted. They suggested Order Line Items for sales/orders and Detail Page Traffic Event Notifications for traffic, but the same email thread contains a reported Order Line Items undercount while initial loading was incomplete. Do not change any current sales source solely from this recommendation; reconcile a fully synced account against Seller Central first.
- PII shipment/address tables require a separate paid enablement and up to 24 hours before data appears. They are not required for the current Brand View/FBA availability calculations.

## Requested next architecture: SaaS scheduled sync (2026-08-04)

- Requested, not yet implemented: convert Upriver from user-triggered report refreshes into a SaaS-wide scheduled data-sync architecture. The dashboard should load only shared Supabase snapshots/history; ordinary users should not cause DataDoe exports by opening pages, changing filters, sorting, or navigating.
- Requested schedule: sync all non-US marketplace account/report data daily at **07:30 IST** (`02:00 UTC`) and sync US marketplace account/report data daily at **16:00 IST** (`10:30 UTC`). Interpret "US" as Amazon US marketplace unless the owner clarifies otherwise; CA/AU/IN/EU stay in the non-US morning bucket.
- Future accounts and reports should join the schedule through a central server-side sync registry, not page-specific refresh buttons. New reports still need an explicit registry entry and adapter; arbitrary future code cannot be discovered safely without a declared source/snapshot contract.
- Ads data needs special handling: preserve daily history and re-fetch a rolling correction window so delayed attribution can update prior days. Normal non-ads report snapshots can be replaced/versioned daily after successful validation.
- Security target: do not claim true end-to-end encryption, because server-side DataDoe ingestion and report computation require the server to read data. Implement production SaaS security instead: TLS, encryption at rest, RLS, server-only service-role/DataDoe secrets, least-privileged cron auth, audit logs, tenant/account isolation, no secrets in browser/logs, rate limits, and security headers.

## In progress: complete Brand View directory across both DataDoe organisations (2026-08-04)

- Brand View reporting refinement deployed as `dpl_DB5axa9shoGzGB1JxM71HfTgZczC` (`https://upriverdashboard.vercel.app`): Ad Spend and TACoS are hidden from every Daily Snapshot, Monthly Snapshot, 7-Day Performance table, and matching export. FBA Cover now displays whole **days**, calculated as available FBA units divided by average daily brand units sold in the currently selected date range. This replaces the prior opaque month display based on a cross-month MTD pace. FBA figures remain snapshot-backed; when a saved FBA snapshot has no country allocation, country rows stay `n/a` rather than inventing an allocation. `npm run verify` passed with 54 shared assertions, 60 Brand View assertions, and the complete Vite production build.
- Brand View monthly advertising refinement deployed as `dpl_4ojX3A1SveVeXKxsVrSEZHXfEHfs` (`https://upriverdashboard.vercel.app`): Daily remains free of Ad Spend/TACoS. Monthly Snapshot now shows **current-month** Ad Spend and TACoS using the exact same current-month date window as `Current Month Actual`; TACoS is recomputed as current-month ad spend divided by current-month sales. The 7-Day Performance table continues to show brand-scoped day-by-day Ad Spend/TACoS plus a 7-day total. The Monthly Snapshot anchors to the latest saved sales date and does not label missing future days as zero. `npm run verify` passed with 54 shared assertions, 60 Brand View assertions, and the complete Vite production build.
- Removed the obsolete **Brand View** item from the Account View sidebar. Brand View remains a separate mode selected only with the existing header **Account view / Brand view** switcher; no dashboard, filter, report, or Brand View logic changed. Verified and deployed as `dpl_7DxPndCa2fGmBjXnLYSDyijNvjeG` (`https://upriverdashboard.vercel.app`).
- Investigated the report selector missing secondary-organisation accounts in Brand View.
- Found and fixed a server-side merge bug: `discoverConnectedAccounts()` rejected a raw seller/vendor ID that appeared in both DataDoe organisations. Raw IDs are only unique within their organisation, so the refresh could fail before saving the combined account directory.
- Account discovery now merges by the existing public, connection-scoped ID. Primary remains unchanged; the secondary account is retained as `dd-secondary:<raw-id>`. A regression test covers the same raw ID occurring in both connections.
- Applied the same connection-scoped identity rule to the automated Ads sync so a matching raw ID cannot abort the scheduled cross-organisation job.
- Verification complete: `npm run verify` passed (54 shared/report assertions, 59 Brand View assertions, and the full production build).
- Deployed to production: `dpl_DVpnYRQwwpzGGhnpqvzm3uViyY4j` (`https://upriverdashboard.vercel.app`).
- Next user action: open **Brand view** and use **Load portfolio brands** once. This explicitly refreshes the shared directory from both DataDoe organisations; after it completes, every authorised user reads the same saved list without another DataDoe request.
- Production investigation after deployment: the Brand View directory requests return HTTP 200, including the manual load, so the remaining warning is a truthful partial-data state rather than an API-key, cross-organisation merge, or dropdown failure. The unresolved accounts have no saved `catalogBrands`/brand rows in Supabase. The current cache-first directory deliberately avoids Product Catalog exports because prior attempts returned DataDoe HTTP 402 or timed out; Supabase cannot infer brand names that neither its snapshots nor DataDoe supplies. To make these accounts complete, their DataDoe **Product Catalog by ASIN** source must be enabled/credit-available, or an account-scoped Dashboard/SKU P&L refresh must first save its brand data.
- Implemented the catalog-seeding replacement: an explicit **Load portfolio brands** click now syncs the authoritative Product Catalog separately for each permitted account, with one primary and one secondary account processed per serverless request. The browser continues those small batches until the directory is complete, avoiding the old 504 risk. Each result is stored as a compact shared `brand-catalog` snapshot in Supabase, including named empty catalogs and upstream-unavailable states. Normal loads remain cache-only; a new explicit click can retry catalog failures after DataDoe credits/source access are corrected.
- Important design rule: recent sales brands are a helpful temporary fallback, never proof of a complete catalog. Every account without a completed `brand-catalog` snapshot stays queued so zero-sale brands are not silently omitted.
- Verification after the catalog-sync implementation: `npm run verify` passed (54 shared/report assertions, 59 Brand View assertions, and the full production build).
- Deployed catalog sync to production: `dpl_4YqKyG7rcAHYABkqndo1DujahnZT` (`https://upriverdashboard.vercel.app`). Pending: perform the first signed-in production **Load portfolio brands** run; it will seed both DataDoe organisations in small batches. If DataDoe rejects a particular catalog, the page now names the affected account and preserves all successful account catalogs.
- Production seed feedback: the initial catalog sync reached the secondary organisation but every `dd-secondary:` account was returned as unavailable. This is a Product Catalog source/export-access condition in the secondary DataDoe organisation, not a cross-account merge failure. The UI is being changed to group failures by connection and show the exact server error rather than listing internal account IDs.
- Deployed the grouped catalog-error UX: `dpl_7J1FnZY4ycXLsTsuxuwKXuyUpGAA` (`https://upriverdashboard.vercel.app`). The next manual directory sync will reveal the precise DataDoe Product Catalog failure for the secondary connection, while keeping the successfully cached primary brands available.
- Confirmed from the secondary DataDoe Settings screenshot: **Product Catalog by ASIN** and **Product Catalog by ASIN (Raw JSON)** are enabled, but both show **0 rows**. This is the direct reason secondary brands cannot appear in Brand View: DataDoe has not populated any catalog records for that organisation's connected Amazon accounts. Enabling the table alone is insufficient; the upstream Amazon connection/catalog ingestion must be backfilled or reconnected in DataDoe before any dashboard code can discover those brand names.

Last updated: 2026-08-04 (Scheduled-sync foundation deployed and production-validated; upstream DataDoe coverage remains partial)

## Scheduled-sync SaaS foundation — deployed (2026-08-04)

Phase 1 ("foundation first") of the website-wide scheduled DataDoe sync requested
above. Built and senior-reviewed, `npm run verify` green (including **23 sync
assertions**, 54 insight assertions, 60 Brand View assertions, and the full 1.12 MB
application build). The production migration is applied, the GitHub Actions
secrets are configured, and the foundation is pushed to `main` and deployed.
Normal report reads are Supabase-only, but the old explicit per-page refresh
buttons still trigger DataDoe until the declared UI-removal phase is completed.

### Schedule (exact)

- **non-US** bucket → **02:00 UTC** (07:30 IST) — `account.country !== "US"` (CA/AU/IN/EU/GB/…).
- **US** bucket → **10:30 UTC** (16:00 IST) — `account.country === "US"` only.
- Classification is metadata-driven (`bucketForCountry`, from DataDoe
  `marketplaceCountryCode`); **unknown/empty country is logged to `sync_errors` and
  skipped, never mis-bucketed**.

### What was built (files)

- **Migration** `supabase/migrations/20260805_scheduled_sync.sql` (additive only):
  `account_directory`, `sync_runs`, `sync_targets` (RLS-no-policy = service-role
  only), `sync_errors`, `audit_log`. Reuses `touch_updated_at()`,
  `is_dashboard_admin()`, and `report_refresh_locks` + `claim_report_refresh_lock`
  (no new lock table, no heartbeat RPC).
- **Registry** `lib/server/sync/registry.js` — the single declarative source of
  truth. Enabled this pass: the 4 Ads sources + `brand-sales`.
  Declared but `enabled:false` (follow-up): `fba-plan`, `daily-reporting`,
  `reconciliation`, `sku-pl`, `keyword-rank`, `content-changes`, `listing-health`,
  `buy-box-loss`, `returns-leakage`, `ppc-performance`, `listing-optimizer`.
  **Honest limitation encoded in-file:** a new report joins only by adding an entry
  + adapter; no arbitrary-code discovery.
- **Orchestrator** `lib/server/sync/run-sync.js` (`runScheduledSync({bucket})`):
  per-bucket lock (90s, reused RPC) → open `sync_runs` → discover both orgs +
  upsert `account_directory` + classify → ordered work list → bounded ~50s loop
  with per-target lock, idempotent build-then-save, checkpoint to `sync_targets`,
  errors to `sync_errors`, **continue-on-failure** → retention (when drained) →
  finalize + `audit_log`. Returns `{drained, remaining, counts}`.
- **Adapters** `lib/server/sync/adapters/*`: `report-adapter.js` (generic, reuses
  existing builders, keeps last-known-good — save only on success), `ads.js`
  (pass-through to existing `runAdsSync`), `index.js` (build map; the only module
  importing `api/datadoe.js`).
- **Endpoints**: `api/cron/sync.js` (`?bucket=`, Bearer `CRON_SECRET` via
  `verifyCronRequest`); `api/sync.js` (`POST` = admin-only "Sync now" via
  `assertAdmin`, rate-limited + audited, runs the scheduled path — never per-page
  DataDoe; `GET` = read-only account-scoped sync status). `lib/server/sync/status.js`
  (pure shaper; non-admin sees strictly their own accounts).
- **Supabase helpers** added to `lib/server/supabase.js` (service-role wrappers):
  `upsertAccountDirectory`, `getAccountDirectoryRows`, `insert/updateSyncRun`,
  `getSyncTargets`, `upsertSyncTarget`, `insertSyncError`, `insertAuditLog`,
  `getReportSnapshotsMeta`, `deleteReportSnapshotsOlderThan`.
- **Builder extraction (behavior-preserving):** `buildBrandSalesPayload({apiKey,ids,from,to})`
  is now a co-located named export in `api/datadoe.js`; the `action=brand-sales`
  handler calls it (single implementation). `ADS_SOURCES` is now exported.
- **Driver**: `.github/workflows/scheduled-sync.yml` (repo root) — fires at exact
  02:00 / 10:30 UTC, loops the endpoint until `"drained":true`. `vercel.json` gets
  two best-effort daily crons (`/api/cron/sync?bucket=non-us` @ `0 2 * * *`,
  `?bucket=us` @ `30 10 * * *`) + security headers (HSTS, CSP, nosniff,
  frame-options, referrer/permissions policy).
- **Tests** `scripts/test-sync.mjs` (wired into `npm run verify`): 21 assertions —
  bucket US/non-us/unknown, schedule constants ↔ vercel.json, registry coverage +
  enabled set + reportVersions, `dd-secondary:` namespacing + cross-org block,
  batch ≤5, lock acquire/release/concurrent-blocked (emulated RPC), resumable
  per-cycle checkpoints, bounded Ads scopes, scheduler-only snapshot pruning,
  last-known-good on build/validation failure, ads natural-key dedup, and
  non-admin status isolation.

### Codex production-gate review (2026-08-04)

The initial handoff was not safe to deploy. Codex found and repaired these issues:

1. The orchestrator wrote `sync_targets` but never read them to resume. Every
   GitHub loop call restarted at the first report, so a bucket longer than 50
   seconds could repeatedly rebuild early accounts and never reach later ones.
   Targets now carry `cycle_date`; successful targets are skipped for that cycle,
   failures receive at most three attempts, and a new day resets eligibility.
2. One non-US Ads item ran both the managed-country and `OTHER` workers, each with
   its own 45-second budget, inside one 60-second Vercel function. They are now
   separate durable queue targets, so no invocation starts more than one Ads
   worker.
3. The 16 legacy Ads crons used different lock scopes from the new scheduler, so
   they could duplicate exports despite the handoff claiming otherwise. They are
   removed from `vercel.json`; only the two bucket kick-starter crons remain.
4. Daily report windows created a new snapshot key every day and retained many
   full payloads. Scheduler snapshots now carry `syncManaged=true`, and the new
   service-role-only prune RPC removes older scheduler-owned snapshots after a
   successful save without touching custom/manual snapshots.
5. Sync status previously labelled the requested end date as the latest source
   date. The adapter now records the actual latest payload/row date, so an
   upstream-lagged report is not presented as current.
6. The GitHub driver previously exited successfully after 40 incomplete calls.
   It now fails visibly on iteration exhaustion or terminal target failures.

The additive migration `20260805_scheduled_sync.sql` was applied successfully to
production Supabase. Verified tables include `account_directory`, `sync_runs`,
`sync_targets`, `sync_errors`, and `audit_log`; the scheduler prune RPC was created
in the same transaction.

### First production run + timeout hardening (2026-08-04)

- Foundation commit `10114ff` was pushed to `main` and deployed as Vercel
  deployment `dpl_77J5x6fRigNZrrZnr2o6ZYpKTn5b`, aliased to
  `https://upriverdashboard.vercel.app`. Production returned HTTP 200 with CSP,
  `nosniff`, and referrer-policy headers; an unauthenticated cron request returned
  HTTP 401 as required.
- GitHub Actions run `30926551090` proved the repository secrets are correct:
  it authenticated to Vercel and began draining 84 targets across 38 non-US
  accounts. Ads targets and multiple `brand-sales` snapshots succeeded and were
  checkpointed in Supabase.
- That run also exposed two honest upstream limitations: some `brand-sales`
  exports returned DataDoe HTTP 402, and seven secondary-organisation targets
  returned HTTP 404 because Order Line Items source
  `89b27535d27c2a94db5ae39af4717f542624ff4df7802fd633e16c78674a1778`
  is unavailable in that DataDoe organisation. These remain visible terminal
  target failures; the scheduler does not fabricate or erase data.
- The run then encountered a Vercel `FUNCTION_INVOCATION_TIMEOUT` (HTTP 504) on
  iteration 16. The driver previously treated every non-200 response as fatal.
  Follow-up hardening now gives all shared DataDoe helpers an async-local server
  deadline: fetches and poll sleeps defer before the 60-second cap, preserve the
  previous snapshot, checkpoint the target as deferred without consuming a retry,
  and release locks normally. The GitHub loop now retries transient HTTP 429/5xx
  responses after backoff while keeping authentication/permanent 4xx errors fatal.
- A second live run resumed correctly from Supabase checkpoints and reached
  `sales-movers`, but one account's multi-export build repeatedly exceeded the
  safe deadline. Re-running the whole build would spend new DataDoe exports
  without progress, so the validation run was cancelled and scheduled
  `sales-movers` was disabled. Its normal dashboard/report behavior is untouched.
  Re-enable it only after its adapter persists sub-export checkpoints across
  serverless invocations. This leaves the proven four Ads sources + `brand-sales`
  enabled in Phase 1.
- Timeout hardening is commit `52a3234`; the long-adapter safety gate is commit
  `390c927`. The final production deployment is
  `dpl_Dwffk1isyiLuJYinbWKNkuGb9Lvs`
  (`https://upriver-dashboard-jvp35ux0n-laxmikant1604s-projects.vercel.app`),
  aliased to `https://upriverdashboard.vercel.app` and verified `READY`.
- Final non-US validation run `30929409568` returned HTTP 200 and
  `drained:true` on its first call: 46 enabled targets, 19 already-successful
  targets skipped, 27 terminal `brand-sales` failures, zero deferred targets,
  and no 504. GitHub correctly marked the run failed because terminal upstream
  failures remain; that red status is intentional operational visibility, not a
  scheduler/authentication failure. DataDoe source access/credits must be fixed
  before all 38 non-US accounts can receive Dashboard snapshots.

### Why the 60s cap needs the GitHub driver

One Vercel invocation is capped at 60s; a full bucket (≈15 accounts × multi-export
reports, 20–46s each) cannot drain in one call. The endpoint does a bounded slice
and returns `drained:false`; the GitHub Actions loop re-calls until drained.
Idempotency lives in `sync_targets` + natural-key upserts, not the lock — a call
killed at 60s wrote nothing partial (snapshots save only on success). Vercel Hobby
crons are hour-imprecise and don't loop, so they are a best-effort kick-starter
only; the 90s bucket lock de-dups a Vercel + GitHub double-fire.

### Security decisions

- No true E2EE (documented): the server must read data to ingest/compute. Secrets
  stay server-only (`CRON_SECRET`, `DATADOE_API_KEY[_SECONDARY]`, Supabase
  service-role); browsers use RLS via `account_permissions`. TLS + Supabase
  encryption at rest. CSP allows self + Google Fonts (`fonts.googleapis.com` /
  `fonts.gstatic.com`) + Supabase (`https://*.supabase.co`, `wss://*.supabase.co`);
  **DataDoe origin deliberately absent** (browser never calls it).
- `api/sync.js` POST is admin-only + per-user rate-limited (3/60s) + audited.

### Env / setup for Codex before enabling

- Vercel (already present): `CRON_SECRET`, `DATADOE_API_KEY`,
  `DATADOE_API_KEY_SECONDARY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`/
  `SUPABASE_SECRET_KEY`, `DASHBOARD_APP_URL`.
- GitHub repo secrets (new): `SYNC_ENDPOINT` (e.g.
  `https://upriverdashboard.vercel.app/api/cron/sync`) and `CRON_SECRET` (same value).
- Migration applied successfully on 2026-08-04 with `npm run db:migrate`.

### Known limitations / risks (for review)

1. **Live DataDoe coverage is partial** — Ads and multiple primary `brand-sales`
   targets succeeded in the first production run. Some primary exports returned
   HTTP 402, and the secondary organisation lacks the configured Order Line Items
   source ID (HTTP 404). Resolve DataDoe credits/source enablement rather than
   weakening scheduler validation. Scheduled `sales-movers` is separately disabled
   until it can resume sub-exports without repeating token-consuming work.
2. **`reportVersion` alignment** — enabled ones are verbatim from the browser
   (`brand-sales-shared-v1`, `sales-movers-v1`). If a scheduled window differs from
   a user's chosen range, the existing `getLatestReportSnapshot` stale fallback
   still serves the newest scheduled snapshot. Insight reportVersions for the
   `enabled:false` entries must be reconfirmed against the exported `*_VERSION`
   constant when enabling.
3. **fba-plan deferred** — its handler is larger/entangled (isUS discovery, many
   helpers). Extract `buildFbaPlanPayload({apiKey,ids,to})` co-located in
   `api/datadoe.js` (like brand-sales), add to `adapters/index.js`, flip
   `enabled:true`. One report adapter per account per call; keep 6-month reports
   (`reconciliation`,`sku-pl`) disabled until windowed checkpointing.
4. **CA re-bucketing** — the new scheduler intentionally puts CA in the non-US
   02:00 UTC bucket. The legacy Ads schedules were removed during review to avoid
   different lock scopes creating duplicate exports.
5. **CSP `script-src 'self'`** — verify no inline bootstrap in the built
   `dist/index.html` in a preview (watch console for CSP violations); the app uses
   inline styles so `style-src 'unsafe-inline'` is retained.
6. **SaaS tenancy boundary** — current authorization is one Upriver workspace:
   global admin plus per-user `account_permissions`. That safely supports many
   Upriver users, but it is not yet multi-company tenancy. Before onboarding
   unrelated customer organisations, add a tenant/workspace key to users,
   accounts, permissions, snapshots, sync targets, COGS, Ads rows, and audit logs,
   then enforce it in RLS and every server query.
7. **Secrets configured** — GitHub repository secrets `SYNC_ENDPOINT` and
   `CRON_SECRET` are present, and the first workflow authenticated successfully.
   Never print, export, or commit their values. The remaining release validation
   is a production rerun after timeout hardening, not secret setup.

### Follow-up phases (declared, not done)

- Extract + enable the remaining ~11 report adapters (fba-plan first).
- Remove/neutralise the manual-refresh UI: the `refresh=1` senders in `src/App.jsx`
  (`fetchRows`/`fetchDaily`/`fetchPlan`/`fetchReconciliation`/`fetchSkuPl`/
  `fetchKeywordRank`/`fetchContentChanges`/`fetchAccounts`/`fetchBrandDirectory`),
  the `SnapshotGate` "Refresh from DataDoe" button, and **the auto
  legacy-directory refresh at `App.jsx:1403-1413`**. Replace with the read-only
  sync-status indicator (`GET /api/sync`) + admin "Sync now" (`POST /api/sync`),
  and an optional `dashboard_events` realtime subscription.

### Review + preview validation steps (for Codex)

1. `cd sales-dashboard-live && npm run verify` (insight + Brand View + 21 sync + build).
2. Migration is applied. Set GitHub secrets before pushing/deploying.
3. Preview deploy; confirm: unauthenticated `/api/cron/sync?bucket=us` → 401;
   non-admin `POST /api/sync` → 403; `GET /api/sync` returns only the caller's
   accounts; a `Bearer CRON_SECRET` call writes a `sync_runs` row and a
   `brand-sales`/`sales-movers` snapshot; a second user reads it with **zero**
   DataDoe calls; a concurrent bucket call returns `skipped:'locked'`.
4. Confirm the app still loads (fonts/Supabase) under the new CSP — no console CSP
   violations. Then deploy to production and record the deployment id here.



## Brand View: multi-currency brands now open as one clean table (2026-08-04)

### The problem the owner reported

The owner's reference layout (a single-currency brand, e.g. "Bebi Born" all in
EUR) shows the clean shape: one coloured **All Markets** total row, flags, no
dividers. But a genuinely multi-currency brand (e.g. "Caruso Italy" — AUD, CAD,
INR, USD) opened in **Original marketplace currency** mode, which the table
builder renders as stacked **currency bands** (`AUD · 1 MARKETPLACE`) with no
single All Markets total. That is correct behaviour — you cannot sum
A$ + C$ + ₹ + $ into one number — but it is not the layout the owner wanted.

### Why it looked different (this was NOT two components)

Both Brand View pages render through the same `src/views/BrandReports.jsx`, and
`src/lib/brand-view-tables.js` chooses the layout purely from **how many
currencies are in the data**: one currency → clean single table with an All
Markets row; more than one → currency bands, no cross-currency total. Nothing was
broken. The only reason Caruso showed bands is that the portfolio page **defaulted
the currency selector to Original**, and Caruso trades in four currencies.

### The fix — a data-driven default currency (no table-logic change)

New shared hook **`useBrandCurrency(model, resetKey)`** in
`src/views/brand-controls.jsx`. Until the user picks a currency, it follows the
data:

- **Multi-currency brand** (more than one distinct marketplace currency in
  `model.countries`) → default to **`DEFAULT_REPORT_CURRENCY` = "USD"** (a named
  export at the top of `brand-controls.jsx`; change that one line to make INR or
  another currency the default). Converting to one currency collapses the bands
  into the same single clean All Markets table as the reference.
- **Single-currency brand** → stay in **Original** (its own currency), which
  already renders as the reference single-table shape. So an all-EUR brand like
  Bebi Born still shows €, unchanged.
- The moment the user picks a currency themselves, `userChosen` latches and the
  data no longer overrides them. A new brand/scope (`resetKey`) forgets that
  choice so the next brand gets its own sensible default. `resetKey` is
  `` `${accountId}::${brand}` `` on the account page and `` `${brand}::${idsKey}` ``
  on the portfolio page.

Wired into both `src/views/BrandView.jsx` and `src/views/BrandPortfolio.jsx`:
the local `useState(ORIGINAL_CURRENCY)` was replaced by the hook, and `model` is
now computed **before** `useFxRates` so the hook can read the data's currencies.
USD is the FX base, so no cross-rate is derived for the default. Converting still
needs the cached FX table; if a rate is missing the report shows the usual banner
and a dash, never a substituted number, and Original is one dropdown click away.

### Verification (2026-08-04)

- `npm run verify` green: insight assertions + **59 Brand View assertions** +
  production build (1,119.79 kB main chunk). No table-shape test changed; the
  "single-currency report has no currency bands and exactly one All Markets row"
  assertion still passes because the builder was untouched — only the default
  currency selection changed.

### Deployment (2026-08-04)

- Commit `9d56efe` deployed from the repository root as Vercel deployment
  `dpl_E3u3iMpdahpAuEwEUEMGw3zfVkda` (target production, READY).
- Stable alias **https://upriverdashboard.vercel.app** returned HTTP 200 and
  serves the new bundle `assets/index-2PJr_5FU.js` (also HTTP 200). The default
  reporting currency ("USD") is minified/inlined, so it is verified by the fresh
  bundle hash rather than by a string search.
- Local `main` holds commits `9d56efe` (code) and the follow-up memory commit.
  Neither was pushed to `origin`
  (github.com/LaxmiKant1604/Upriver-Dashboard) — push when you want GitHub in
  sync; production is already live regardless.

## Syncing all brands from BOTH DataDoe organisations (mechanism, 2026-08-04)

The owner asked to "sync all brands from both DataDoe accounts". This is a
**runtime admin action that already spans both orgs — there is no code change and
no CLI script that can do it**, and it cannot be run from a developer workstation
(DataDoe returns HTTP 403 to non-Vercel IPs, and the endpoint needs the admin's
signed-in bearer token).

### How the sync works (already implemented, both orgs covered)

- Both keys are read only in `getDataDoeConnections()`
  (`lib/server/datadoe-connections.js`): `DATADOE_API_KEY` (required) and
  `DATADOE_API_KEY_SECONDARY` (optional; secondary accounts get a stable
  `dd-secondary:` id prefix so raw ids can't cross an org boundary).
- `discoverConnectedAccounts()` (`api/datadoe.js`) iterates **every** connection,
  so both orgs are covered anywhere it runs.
- **Trigger:** the **"Load portfolio brands"** button in
  `src/views/BrandPortfolio.jsx` → `fetchBrandDirectory` in `src/App.jsx` →
  `GET /api/datadoe?action=brand-directory&refresh=1`. Only on `refresh=1` does
  the server run cross-org discovery, filter to the signed-in user's permitted
  accounts, build the brand→account **v2** map (`brandAccounts`) from saved
  Supabase snapshots, and persist both the `brand-directory`
  (`brand-directory-shared-v2`) and `account-directory`
  (`account-directory-shared-v1`) snapshots for every user.
- The brand list itself spends **no** DataDoe export — it is read from each
  account's saved snapshots (`catalogBrands` / row-level brand fields).

### Steps for the owner to actually sync both orgs

1. Sign in as an administrator and open the header **Brand view** (portfolio).
2. Click **Load portfolio brands** once. This discovers accounts across both
   DataDoe orgs and rebuilds the shared brand directory for all users.
3. For any **secondary-org account that shows no brands**: a brand only appears
   once that account has at least one saved snapshot. Open Account View for it and
   refresh its Dashboard (or SKU P&L) once; its brands then appear for everyone.

### Known gaps in the sync (candidates for a future hardening pass)

- Discovery is **refresh-gated** by design (ordinary reads are Supabase-only to
  avoid DataDoe cost), so newly added secondary accounts are invisible until a
  manual "Load portfolio brands".
- A non-admin only sees accounts explicitly granted to them.
- An account with **no saved snapshot contributes zero brands** (returned as
  `unresolvedAccountIds`, `partial: true`).
- If the **same raw account id exists in both orgs**, `discoverConnectedAccounts`
  (and the Ads cron's `runAdsSync`) **throw and abort the whole discovery**, not
  just the duplicate. Making that non-fatal (skip/prefix and continue) would make
  the cross-org sync robust to one collision — offered to the owner as an optional
  follow-up, not yet done.

## Portfolio Brand View upgraded to the shared format (2026-08-04)

**This supersedes the 2026-08-03 "Brand View scope clarification" guardrail
below.** The owner reviewed the header `Brand view` report on 2026-08-04, saw
the old layout, and chose "upgrade the portfolio report to the new format" over
"replace it with the single-account page". Both Brand Views now render the same
three reports; only the account set differs.

### What changed

- **A defect was found first:** the account-scoped `brandview` route was
  unreachable. Commit `99b001e` removed the sidebar entry that was the only
  thing setting `view = "brandview"`, so the module shipped on 2026-08-03 was
  dead code. The sidebar entry is restored.
- The header `Brand view` switcher still opens the **cross-account** report —
  one brand across every account that sells it. That behaviour is unchanged and
  was explicitly kept.
- `BrandPortfolioDashboard` in `App.jsx` was **deleted** and replaced by
  `src/views/BrandPortfolio.jsx`, which renders the shared reports.

### One report definition, two scopes

| Layer | File |
| --- | --- |
| Per-account slice | `buildAccountBrandSlice` in `lib/server/reports/brand-view.js` |
| Merger | `assembleBrandViewPayload` — same payload shape for 1 or N accounts |
| Single account | `buildBrandViewSnapshot` → action `brand-view` |
| Cross-account | `buildBrandViewPortfolioSnapshot` → action `brand-view-portfolio` |
| Tables | `src/lib/brand-view-tables.js` (pure, unit-tested) |
| Presentation | `src/views/BrandReports.jsx` |
| Controls | `src/views/brand-controls.jsx`; pure range logic in `src/lib/brand-view.js` |

The portfolio is literally the sum of the same per-account numbers, so the two
reports cannot drift apart, and the exports consume the same table model as the
screen.

### Cross-account merge rules

- Sales and units for the same marketplace are **summed** across accounts, and
  the contributing accounts are named under the country (e.g. India = "Indya
  Store IN, MeridienMarket IN").
- **Ad spend is available for a marketplace only when EVERY account selling
  there has saved Ads coverage.** One covered account out of two would give a
  partial sum that understates TACoS, so the cell is unavailable instead. The
  Ads window per marketplace is likewise the intersection.
- Sales coverage is the intersection (latest start, earliest end), so a
  last-year comparison is offered only when every contributing account can
  answer for that window.
- `salesLatestDate` is the newest date any account populated;
  `salesCompleteThrough` is the newest date **all** of them have. When they
  differ, the lagging accounts are named in a note and the freshness bar says
  "all accounts complete through &lt;date&gt;".
- Because accounts refresh at different times, the portfolio page opens on
  **Last 30 days** rather than a single latest day that may be populated for
  only some accounts. Single-account Brand View still opens on the latest day.
- Account-level-only FBA inventory is excluded from country rows rather than
  assigned to a marketplace, and is surfaced on All Markets only when the report
  has a single currency group.

### Two real bugs fixed while doing this

1. `aggregateBrandSales` took the first currency it saw for a marketplace. Some
   saved rows carry an empty currency, so if one came first the whole
   marketplace rendered as "currency unavailable". It now takes the first
   **non-null** currency.
2. The FX effect read its own loading flag from the dependency list, so a failed
   fetch re-ran it in an unbounded retry loop. The attempt is now tracked in a
   ref, with the Refresh button as the explicit retry.

### Verification (2026-08-04)

- `npm run verify` green: 53 insight + **57** Brand View assertions + build.
  New cases cover the merge, the conservative ads rule, coverage intersection,
  the snapshot key, and that both scopes build identical table shapes.
- **Real-data portfolio reconciliation**, "Caruso Italy" across its 6 mapped
  accounts, through the real Supabase helpers:
  - AU raw `50,507.61` vs built `50,507.61`; CA `10,655.65`; IN
    `38,302,861.92`; US `348,236.05` — **worst delta 7.451e-9** (float noise on
    a 38-million total).
  - India and the United States are correctly single merged rows naming both
    contributing accounts.
  - Converted USD: group total = sum of visible rows = independent
    recomputation, **exact**.
  - Built in 5.6 s, 1,393 country/day rows, 81.7 kB saved snapshot.
- The bundle **shrank** (1,126 kB → 1,118 kB) because the duplicate report
  component was removed.

### Presentation matched to the reference report (2026-08-04, second pass)

The owner compared the first build against the reference screenshots. The
numbers were right but the layout was not. What changed, all in
`src/lib/brand-view-tables.js`, `src/views/BrandReports.jsx` and the `.bv-*`
CSS — no calculation was touched:

- **One All Markets row, not one per currency.** A currency group now gets its
  total only when it aggregates more than one marketplace, or when it is the
  only group. Four singleton currencies used to print four All Markets rows that
  each duplicated their single country row.
- **Currency bands.** When a report spans more than one currency, each group is
  introduced by a divider (`EUR · 9 marketplaces`) so the groups read as stacked
  tables rather than one table with several confusing totals. With a single
  currency — every converted view — there is no band and the table is exactly
  the reference shape.
- **No sub-label on every row.** Currency moved to the band; contributing
  account names moved to the row tooltip; `(FC only)` is now an inline suffix on
  an inventory-only marketplace, as in the reference.
- **Reference column names**: Total Sales, LY Sales, Ad Spend, TACoS%, FBA Inv.,
  Inv Cover, Units. Headers are sentence case at 11.5px instead of 9px all-caps,
  and rows are 13px with 13px padding.
- **Inventory cover is in months** (`3.0m`), with the exact day count in the
  tooltip. A marketplace with no inventory record reads `n/a`, distinct from the
  em dash used for a metric that simply has no value.
- **Toned columns**: FBA Inv. and Inv Cover green, the current-month actual and
  run rate green, Ad Spend/TACoS% accent, and the latest day plus 7D Total
  tinted in the 7-day grid.
- Subtitles now state the run-rate divisor explicitly, e.g.
  `Mar 2026 – Aug 2026 · Aug 2026 MTD (3 days) · RR = (Act ÷ 3) × 31`.

Tests grew to **59** and now cover the total-row rule, the single-currency
shape, months-and-`n/a`, and the `(FC only)` suffix.

### Deployment (2026-08-04)

- Commits `167c27b` (the upgrade), `0b7dc59` (removing the retired report's
  now-dead CSS) and `a261d89` (the reference layout pass), deployed from the
  repository root. The final deployment is `dpl_75y6h5b8mKdC2CeYHwB1LDGGNHFC`.
- Stable alias **https://upriverdashboard.vercel.app** returned HTTP 200 and
  serves `assets/index-Dd7fnBoO.js`. Verified by string presence in the served
  bundle: `Total Sales`, `LY Sales`, `TACoS%`, `FBA Inv.`, `Inv Cover`,
  `(FC only)`, `bv-band`, `bv-col-positive`, `bv-col-latest`,
  `Units by country`, `All Markets` and `brand-view-portfolio` are all present;
  `Inv. cover (days)`, `Last year sales` and `brand-portfolio-table` are gone.
- All API actions respond 401 unauthenticated, including the new
  `brand-view-portfolio`.
- **First use needs one click of Refresh inside the report.** The portfolio uses
  a new report key, so no snapshot exists for it yet; the page shows its
  "Build from saved data" action. That build reads only saved snapshots and does
  not create a DataDoe export.

### Finding for the owner

`MeridienMarket IN` has not had its Dashboard refreshed since **2026-04-10**, so
the combined India figure understates recent days. The report names it rather
than hiding it. Refresh that account's Dashboard once to correct it.

## Brand View scope clarification (2026-08-03, SUPERSEDED)

- Retained for history. The guardrail below was reversed on 2026-08-04 by the
  owner's explicit choice; see the section above.
- The top-header `Brand view` switcher remains the separate portfolio-level
  report. It must not redirect into Account View or the account-scoped
  `brandview` route. *(Still true: the header opens the cross-account report,
  which now uses the new format.)*
- The standalone `Brand View` sidebar item was removed. *(Reversed — removing it
  made the account-scoped page unreachable.)*
- **Guardrail:** do not change the portfolio Brand View's report layout,
  columns, formulas, source selection or cache behavior. *(Reversed for layout,
  columns and currency; the sources and cache-only contract are unchanged.)*
- **Legacy safety fix:** the older portfolio report trimmed and uppercased
  marketplace country and currency keys before grouping, preventing duplicate
  country rows. That normalisation is preserved in the new aggregation.

## Account-Scoped Brand View — NEW MODULE (2026-08-03)

A new page, route key `brandview`, with the flow **Account → Brand → Brand
Reports**. It is a separate module from everything that existed before. The
Account View dashboard, the older portfolio Brand View (`dashboard` + brand
mode, action `brand-portfolio`), their calculations, cache keys, report keys and
API actions were **not modified**. The only change to an existing route is
additive (see "FBA per-marketplace inventory" below).

### Architecture

| Layer | File | Purpose |
| --- | --- | --- |
| Server report | `lib/server/reports/brand-view.js` | Account+brand aggregation and the brand directory. Every function takes exactly one `accountId`. |
| Server FX | `lib/server/fx.js` | Exchange-rate service: Supabase-cached, provider-cycle aware, stale fallback. |
| API actions | `api/datadoe.js` | `brand-view-brands`, `brand-view`, `fx-rates` (all new, purely additive). |
| Client calc | `src/lib/brand-view.js` | Currency system and the three report computations. Dependency-free and unit-tested. |
| Client page | `src/views/BrandView.jsx` | Control bar, three reports, alerts, empty/loading/error states. |
| Exports | `src/lib/brand-view-export.js`, `src/lib/xlsx.js` | XLSX / CSV / PDF from one shared table model. Lazy-loaded. |
| Styles | `src/styles/theme.js` (`.bv-*`) | Uses existing tokens only. Light theme, no new palette. |
| Migration | `supabase/migrations/20260803_fx_rate_cache.sql` | `fx_rate_snapshots`. **Applied** on 2026-08-03. |
| Tests | `scripts/test-brand-view.mjs` | 46 assertions, wired into `npm run verify`. |

### Scoping guarantee (no cross-account brand leakage)

- Every server function takes **one** `accountId` and reads only that account's
  saved snapshots and that account's saved Ads rows. There is no code path that
  iterates accounts, so leakage is structurally impossible rather than filtered.
- `brand-view-brands` and `brand-view` are in `ACCOUNT_SCOPED_ACTIONS`, so
  `assertAccountAccess` runs before either executes.
- `brand-view` additionally refuses a brand that is not in that account's own
  derived directory, so a crafted request naming another account's brand is
  rejected rather than silently returning nothing.
- The Brand dropdown is disabled until an account is chosen; changing account
  clears brand, report, range and error state.
- Snapshot key is `brand-view:<accountId>::<brand>`. The brand is in the
  **account_id** column, not only the params hash, because the across-midnight
  stale-scope fallback (`getLatestReportSnapshot`) looks up by report key +
  account id alone. Without this, brand A could be served brand B's snapshot.

### Sources

| Metric | Source |
| --- | --- |
| Sales / units | saved `brand-sales` snapshot (Order Line Items joined to Product Catalog, already folded to date/country/currency/brand) |
| Ad spend | `ads_daily_source_rows`, `source_key = asin-performance-v1`, joined to this account's ASIN→brand map |
| ASIN→brand | `fba-plan`, `sku-pl`, `listing-health`, `sales-movers`, `returns-leakage`, `buy-box-loss`, `listing-optimizer` (first match wins). **Not** `brand-sales` — it is folded to brand grain and has no ASIN, which is why the older `brand-portfolio` builder always produced an empty ad join. |
| FBA inventory | `fba-plan.inventoryByBrandCountry` (per marketplace) → `fba-plan.rows` → `listing-health.rows` (both account-level only) |

### Formulas

- **Last Year Sales** — the equivalent calendar window one year earlier
  (`shiftYear`, 29 Feb clamped), shown **only** when the saved snapshot's
  requested window fully covers it. Otherwise `—`, never a partial value.
- **TACoS** — brand ad spend ÷ brand sales for the same marketplace and window.
  Brand-scoped by ASIN, so whole-account spend is never attributed to a brand.
  `null` unless both a real spend and a positive sales base exist.
- **Inventory Cover** — available FBA units ÷ (brand MTD units ÷ elapsed days).
  Displayed in **days**, with the month equivalent (÷30.44) in the cell tooltip.
- **Current Month Run Rate** — current actual ÷ elapsed calendar days × days in
  month. Elapsed days come from the latest **populated** source date, not the
  wall clock, so an unfilled date cannot dilute the projection.
- **Monthly Snapshot** — five completed calendar months + current month actual +
  run rate + current-month ad spend and TACoS. Share of the group total is shown
  under each month value.
- **7-Day Performance** — seven days ending at the latest populated date. Daily
  Sales / Units / Ad Spend / TACoS per currency group, then Units by Country.

### "Unavailable is not zero"

- A marketplace with **no** saved ad rows at all → ad spend `—`.
- A marketplace **with** saved ad rows but none matching this brand → real `0`.
- A requested range extending outside the saved Ads window → `—` (a partial sum
  would understate TACoS).
- Missing FBA data → `—` for both inventory and cover.

### Senior review corrections (2026-08-03)

- **Date filters now drive all three reports.** The selected range's final date
  is the shared reporting anchor: Daily Snapshot uses the complete selected
  range; Monthly Snapshot pivots the five preceding completed months plus the
  selected anchor month; and 7-Day Performance ends on that same anchor date.
  Historical and custom selections therefore no longer leave the Monthly and
  7-Day tables silently pinned to the newest saved day. Inventory cover uses
  the selected anchor month's MTD unit rate.
- **Ads completeness is now marketplace-specific.** Brand View records the
  earliest and latest observed saved Ads row for every country. A selected
  window outside that country's saved span displays Ad Spend and TACoS as
  unavailable, rather than adding only available rows and treating missing
  older days as zero spend. A country with complete Ads coverage but no
  matching ASIN for the selected brand still correctly displays a real zero.
- `adsFrom` / `adsTo` now describe observed saved data, not the wider window
  requested from Supabase. This matters while an Ads account is seeded or
  backfilled.
- Regression coverage was added for partial country coverage and historical
  Monthly/7-Day anchors. `npm run verify` passes **53 insight assertions + 47
  Brand View assertions + production build**.

### Cache behaviour

- Normal page load, account switch, brand switch, date change, currency change,
  sorting and export **never** call DataDoe. Reads are shared Supabase snapshots.
- **A Brand View refresh never calls DataDoe either.** It re-aggregates this
  account+brand from snapshots that already exist and saves one shared result
  under a cross-user `claim_report_refresh_lock`. Getting *newer source* data
  remains the job of the account's own reports, so DataDoe cost is unchanged.
- The derived brand directory is itself saved as a small shared snapshot
  (`brand-view-brands`). Measured on a real 5,302-row account: **2,109 ms** to
  derive, **94 ms** cached. It is rebuilt only when absent or on explicit
  Refresh, so a large account does not re-read a multi-megabyte payload per load.
- Saved payload is bounded by (countries × days); the SKU/ASIN dimension is
  aggregated away server-side, so thousands of SKUs cost nothing extra.
  Measured: 423 country/day rows = **25.9 kB**. Hard design guard at 80,000 rows.

### FX provider and cache policy

- Provider: **ExchangeRate-API Open Access**, `https://open.er-api.com/v6/latest/USD`.
  Docs `exchangerate-api.com/docs/free`, terms `exchangerate-api.com/terms`.
  No API key required; caching is permitted, redistribution is not; attribution
  is required and is shown in the page footer and in every export.
- An optional paid key is supported with no code change: set
  `EXCHANGERATE_API_KEY` server-side and the keyed v6 endpoint is used instead.
  It is read from `process.env` only and never returned to a client.
- Base currency USD; cross rates are derived from two numbers in the **same**
  provider observation so totals cannot drift.
- Cached in `fx_rate_snapshots` keyed by (base, rate_date, provider). RLS is
  enabled with **no policy**, so only the server secret key can read it.
- The provider is called at most once per `FX_MIN_REFRESH_HOURS` (12) **and**
  only after the provider's own published `time_next_update_utc` has passed.
  Refresh does not bypass that — the provider publishes daily. Guarded by
  `claim_report_refresh_lock`.
- Provider unreachable → newest cached table served with `fallback: true` and a
  visible banner. No cached table at all → explicit `unavailable`, never a
  static rate. A currency with no rate renders `—`, never a substituted value.
- Browsers never call the provider; they call `?action=fx-rates`, which reads
  Supabase. Rates are requested only when a conversion currency is selected.
- "FX updated &lt;timestamp&gt;" is shown in the freshness bar and in exports.

### Currency system

- Selector: Original marketplace currency, USD, EUR, GBP, INR, CAD, AUD, JPY, AED.
- **Original mode** groups money by currency with one All Markets row per
  currency. There is deliberately no cross-currency total anywhere.
- **Converted mode** converts each country value individually at full precision;
  the group total is the **sum of those converted values**, so the visible rows
  always add up to the visible total apart from display rounding. Verified
  against live rates: group total === sum of rows === independent recomputation,
  exact equality.
- Unit counts and inventory unit counts are never converted.

### Exports

- Excel (.xlsx), CSV and PDF, all from one table model so an export can never
  disagree with the screen. Lazy-loaded: an 11.76 kB chunk (4.56 kB gzip).
- XLSX is written by `src/lib/xlsx.js`, a dependency-free store-mode ZIP +
  SpreadsheetML writer. Chosen over exceljs/SheetJS because this export needs
  only text and numbers and those libraries add hundreds of kB to the chunk
  (and SheetJS no longer publishes current releases to npm). Verified: valid ZIP
  read back by .NET `System.IO.Compression`, CRC-32 matches the reference value
  `0xCBF43926`, output is byte-deterministic.
- **PDF is the browser's print pipeline**, not a binary generator. A small PDF
  library ships WinAnsi base-14 fonts that cannot render ₹ or a flag glyph, and
  embedding a Unicode subset is a large dependency for one export. The menu says
  "Opens a print view — save as PDF" rather than implying a direct download.
- Every export carries account, brand, report range, as-of, currency mode, FX
  timestamp / fallback status, source freshness, data limitations, All Markets
  rows, country rows, currency symbols and totals. XLSX has one sheet per report
  plus a provenance sheet; CSV has three labelled sections.
- Formula injection is neutralised in both CSV (`csvCell`) and XLSX
  (`sanitizeCell`): a leading `= + - @` is prefixed with an apostrophe.

### FBA per-marketplace inventory (the one additive change to an existing route)

`api/datadoe.js` `action=fba-plan` now also emits `inventoryByBrandCountry`,
folding the same FBA Inventory Health rows to (marketplace, brand). The existing
per-ASIN `rows` and every other field are untouched, `fba-plan-shared-v1` is
unchanged, and the FBA Shipment Plan report does not read the new key — so no
existing behaviour changes and no re-refresh is forced. Brand View falls back to
account-level inventory (clearly labelled) until an account refreshes its FBA
Shipment Plan once.

### Verification evidence (2026-08-03)

- `npm run verify` green: 53 insight assertions + 46 Brand View assertions +
  production build (1,126 kB main chunk, 11.76 kB lazy export chunk).
- `node --check` clean on all 11 changed/new server and shared modules.
- Migration applied via `npm run db:migrate`; `fx_rate_snapshots` verified present.
- **Real-data reconciliation**, account `12f3a683…` / brand `Caruso Italy`,
  driven through the real Supabase REST helpers:
  - sales raw `38,277,641.92` vs built `38,277,641.92`, delta **0.00**
  - units raw `96,379` vs built `96,379`, delta **0**
  - worst per-country money delta **0.000e+0**
  - Daily Snapshot 2026-08-03: built ₹20,092 vs raw ₹20,092; LY ₹130,344
  - Monthly run rate: built `3,209,895` = `310,635 / 3 × 31`
  - Converted USD: group total = sum of rows = independent recomputation, exactly
- **Route simulation** against production Supabase: read before save →
  `snapshotMissing` with **zero** builds; refresh → 200 in 1,733 ms saving a
  25.9 kB shared snapshot; second user's read → 200 in 80 ms from the shared
  snapshot. Reading a sibling brand's key returned nothing (no cross-brand
  fallback), confirming key isolation.
- **FX end to end** against production: first call fetched from the provider and
  saved (`rate_date 2026-08-03`, next update `2026-08-04T00:27:42Z`); second call
  served from cache with no provider request; all eight display currencies
  present. The production cache is now seeded.
- Component smoke render: control bar renders all six controls, the Brand select
  is `disabled` before an account is chosen, and a plain render issues **zero**
  requests.
- Cross-account scope check across five real accounts: every derived brand list
  was a subset of that account's own saved rows; zero invented brands.

### Deployment

- **Header/sidebar boundary correction:** commit `99b001e` was verified with
  `npm run verify` and deployed on 2026-08-04 as
  `https://upriver-dashboard-9rb73ggqq-laxmikant1604s-projects.vercel.app`.
  The stable production URL is `https://upriverdashboard.vercel.app`.
- **Sidebar-only Brand View navigation:** commit `d33349f` was verified with
  `npm run verify` and deployed on 2026-08-03 as
  `https://upriver-dashboard-9dque6c7p-laxmikant1604s-projects.vercel.app`.
  The stable alias is `https://upriverdashboard.vercel.app`.
- **Portfolio separation restore:** commit `32a716e` was verified with
  `npm run verify` and deployed on 2026-08-03 as
  `https://upriver-dashboard-pbyhnc3z5-laxmikant1604s-projects.vercel.app`.
  It restores the top-header Brand View switcher as the separate portfolio
  report. Stable URL: `https://upriverdashboard.vercel.app`.
- **Brand View entry-point repair:** commit `860522d` was verified with
  `npm run verify` (53 insight assertions, 47 Brand View assertions and the
  production build) and deployed on 2026-08-03 as
  `https://upriver-dashboard-g94o18ssp-laxmikant1604s-projects.vercel.app`.
  The stable alias is `https://upriverdashboard.vercel.app`.
- **Review correction deployment:** commit `c3efc1d` (`Fix Brand View filter
  and ads coverage accuracy`) was verified with `npm run verify` and deployed
  on 2026-08-03 as `https://upriver-dashboard-5c8cayie1-laxmikant1604s-projects.vercel.app`.
  It is aliased to the stable production URL
  `https://upriverdashboard.vercel.app`.
- Commit `06df448` on `main`, deployed from the repository root as Vercel
  deployment `dpl_Eyj6jp6BEKmDwgD6EP3wJGCWYPyc` (target production, READY).
- Stable alias **https://upriverdashboard.vercel.app** returned HTTP 200 and
  serves the new bundle `assets/index-BY4rqrhj.js`. Verified by string presence
  in the served bundle, not by hash: `brandview`, `brand-view-brands`,
  `Original marketplace currency`, `Inv. cover (days)` and the page lead copy
  are all present. (A local `build:check` hash will never match Vercel's,
  because build-check injects placeholder public env values.)
- The lazy export chunk `assets/brand-view-export-mm_8LnGe.js` returns HTTP 200
  at 11,781 bytes, confirming code-splitting works in production.
- All three new actions (`brand-view-brands`, `brand-view`, `fx-rates`) return
  **401 without a bearer token**, i.e. authorisation runs before anything else.
  Existing actions (`accounts`, `brand-portfolio`, `fba-plan`) behave exactly as
  before.

### Known limitations and next steps

1. **No account currently has both a `brand-sales` snapshot and ASIN-level Ads
   history.** All `asin-performance-v1` rows belong to `dd-secondary:` accounts;
   all 15 `brand-sales` snapshots belong to primary accounts. Overlap is zero, so
   ad spend and TACoS render as unavailable today. Ad rows *do* carry
   `marketplace_country_code` (US, IN, GB, IT, FR, ES, DE, NL), so the join will
   work as soon as a secondary account's Dashboard is refreshed once from
   Account View. **This is the single highest-value next action.**
2. **No account has a saved `fba-plan` snapshot**, so per-marketplace FBA
   inventory is not yet available anywhere. Brand View currently falls back to
   Listing Health's account-level total (labelled). Refresh FBA Shipment Plan
   once per account to enable per-country inventory and inventory cover.
3. **Multi-currency behaviour is proven by tests, not yet by production data.**
   Every saved `brand-sales` snapshot today is single-marketplace (IN or US). The
   EU multi-marketplace accounts that motivated this report live in the secondary
   organisation and have not had their Dashboard refreshed.
4. **Responsive layout was verified by CSS/breakpoint audit, not by an automated
   browser.** This repo has no browser automation and none was added. The
   `.bv-*` rules define desktop, 900 px and 640 px behaviour, the grid scrolls
   inside its own container with a sticky first column, and the page body never
   scrolls sideways — but a human should confirm on a real tablet and phone.
5. The three report table builders live inside `BrandView.jsx`. Every value they
   render comes from tested pure functions, but the assembly itself is covered
   only by the build. Extracting them into a testable module is a worthwhile
   follow-up.
6. Ads coverage starts 2026-06-02, so a range older than that yields `—` for ad
   spend by design rather than a partial sum.

## Secondary DataDoe Brand View Check (2026-08-03)

- Production configuration check confirmed that both `DATADOE_API_KEY` and
  `DATADOE_API_KEY_SECONDARY` exist. Their values were never displayed or
  stored locally. Direct calls from this workstation to DataDoe's account-list
  endpoint returned HTTP 403 for both keys, so that test is inconclusive for
  Vercel-hosted requests and must not be treated as a secondary-key failure.
- **Root cause found in code:** an earlier Brand View speed optimization only
  discovered connected accounts when the request had no cached IDs. A manual
  Brand Directory refresh with a stale primary-only browser list therefore
  never discovered newly added secondary accounts.
- **Fix completed:** an explicit Brand Directory refresh now always discovers
  both configured DataDoe organisations, filters the result by the signed-in
  user's access, persists the merged account directory, and rebuilds the
  cache-only brand mapping. Normal navigation remains Supabase-only; no
  automatic DataDoe call was added.
- **Deployment:** commit `c6f4e04` is live as Vercel deployment
  `3aaQBTbhnZTrFLhkUcZ7DLj8ViPZ`; the stable alias returned HTTP 200. A signed-in
  administrator must now use the explicit Brand Directory refresh once to
  persist the secondary organisation's current account list. Then select a
  secondary account in Account View and refresh its Dashboard/SKU P&L once to
  seed that account's brand mapping for every user.

## Sellerboard Brand-By-Marketplace Research (2026-08-03)

- Reviewed Sellerboard's public Profit Dashboard and Sales/Stock Map guidance.
  Its model is a durable product catalogue: the user filters products by brand
  (or tags) and marketplaces in one dashboard, then the same active filters
  drive its country/state table and map. Amazon US is shown by state; other
  marketplaces are grouped by country. Sellerboard does not appear to rebuild
  a catalog by calling an external product source whenever a brand is chosen.
- **UPRIVER decision:** Brand View must follow the same shape. The selected
  brand should resolve against a persistent Supabase brand-to-account/country
  directory, and the same page should render its country rows, period trend,
  and future inventory/PPC metrics from that already-scoped data. Do not make
  catalog exports part of normal navigation or selection.
- **Future hardening:** add a dedicated `brand_marketplace_directory` Supabase
  table with brand, public account ID, marketplace country, source/freshness,
  and optional admin override. The deployed cache-only snapshot approach is
  the immediate recovery path; this table is the durable replacement when the
  data model migration is scheduled.

## Brand View V1 Directory Scope Repair (2026-08-03)

- Screenshot review found that Brand View data for `Beeline` correctly showed
  only India, but a red alert reported 26 unrelated accounts with no Dashboard
  snapshot. Cause: a prior v1 Brand Directory supplied brand names without a
  brand-to-account map, and the client fell back to checking every account.
- **Fix completed:** a v1 directory now performs a quiet Supabase-only
  discovery pass to identify the selected brand's saved accounts, records that
  map in the session, and refreshes only those accounts. The browser also
  upgrades the legacy directory to the shared v2 map in the background (still
  Supabase-only), so future users load the targeted map directly. Missing
  snapshots for other brands/accounts are not an error and must never trigger
  a DataDoe export or a red Brand View failure.
- **Deployment:** commit `51fae31` is live as Vercel deployment
  `dpl_4aTcG8T7hduwqhRY6X47WQgSjieC`; the stable alias returned HTTP 200 and
  served the legacy-directory scope repair. For Beeline, the subsequent
  refresh scope is only its discovered India account, and accounts without
  Beeline are no longer reported as a Brand View failure.

## Brand View Bootstrap Repair (2026-08-03)

- **Regression diagnosed:** after the shared-snapshot conversion, a fresh
  browser with no saved `account-directory` snapshot had an empty `accounts`
  array. Brand View then returned before its manual **Load portfolio brands**
  action, leaving the Brand dropdown with only `Select a brand`.
- **Fix:** a manual Brand View directory refresh is now permitted without an
  in-memory account list. For an administrator without explicit account
  permissions, the server discovers all connected accounts only on that manual
  action; for another user it uses only the user's assigned account IDs. It
  returns the permitted account metadata with the shared brand directory so the
  client can bootstrap both selectors. Ordinary Brand View opens remain
  read-only shared-snapshot reads and never call DataDoe.
- The empty shared account directory now surfaces its saved-data message rather
  than silently behaving like an account list. The Brand View refresh controls
  remain available when the user has permission even before account metadata is
  present.
- **Deployment:** commit `03725a9` was pushed to `main` and deployed directly
  to Vercel as `dpl_GHf8psnpS9b3BBLNr4rwQVyFPHrm`. The stable production alias
  `https://upriverdashboard.vercel.app` returned HTTP 200 and served the new
  `index-D7eEO-BV.js` bundle. A signed-in user should open Brand View and click
  **Load portfolio brands** once; the resulting directory is shared for all
  authorised users and later opens read that snapshot without a DataDoe call.
- **Persistence completed:** the brand-directory snapshot is shared and its
  manual refresh now also saves the already-discovered full account directory
  to Supabase. A clean browser first reads the permission-filtered account
  directory, then reads the matching shared brand directory, with no DataDoe
  request. The API enforces the account permission filter on every directory
  read, so saving the full connection catalogue does not expose unassigned
  accounts.
- **Deployment:** commit `927f77a` is live as Vercel deployment
  `dpl_4XQBxC6TnMMRHEUhuRivns182wJi`; the stable alias returned HTTP 200.
- **Country-account routing completed:** Brand Directory v2 stores each
  Product Catalog brand with the exact public account IDs where it exists.
  Selecting a brand now reads and refreshes only those mapped country accounts,
  not every account in the portfolio. The map is built from account-scoped
  catalog exports, works across both DataDoe organisations, and stays inside
  the permission-filtered shared snapshot scope. Old v1 browser data safely
  falls back to the former all-accessible-account behavior until one directory
  refresh seeds v2.
- **Deployment:** commit `15a3064` is live as Vercel deployment
  `dpl_4EqvE4JigbeLZyVyL35MT7jYEWwG`; the stable alias returned HTTP 200 and
  served the targeted-marketplace bundle.
- **Catalog-credit recovery completed:** DataDoe returned HTTP 402 for a
  Product Catalog export while loading the Brand Directory. Brand Directory v2
  now derives its exact brand-to-account map first from saved Supabase
  Dashboard, FBA Plan, SKU P&L, and insight snapshots. It calls Product Catalog
  only for accounts with no saved catalog metadata. If those remaining exports
  still return 402, the usable saved portion is returned and visibly labelled
  instead of blocking the brand dropdown. If no saved report has catalog data,
  DataDoe credits/source access remains an unavoidable upstream requirement.
- **Deployment:** commit `82ac406` is live as Vercel deployment
  `dpl_4eDWyWXVMdqbjs3C5mgc72gdJmXo`; the production alias returned HTTP 200
  and served the cache-recovery bundle.
- **504 repair completed:** the 402 fallback could still make many sequential
  Product Catalog exports for accounts whose snapshots did not expose
  `catalogBrands`, causing a Vercel 504 before the dropdown populated. Brand
  View is now fully cache-first: it serves a prior v1/v2 directory immediately,
  derives brands from saved `catalogBrands` or joined row brands, and never
  launches Product Catalog exports merely to populate the dropdown. This saves
  DataDoe credits and prevents catalog-credit failures from blocking Brand View.
  If no shared report has ever saved brand data for an account, the UI explains
  that an account Dashboard or SKU P&L refresh must seed that data once.
- **Deployment:** commit `03f4d12` is live as Vercel deployment
  `dpl_Dz8wYTpnxcj1sbewiHt53Cf4qkFk`; the stable alias returned HTTP 200 and
  served the cache-only directory bundle.

## Amazon PPC Dashboard Skill Review (2026-08-03)

- Reviewed `Amazon PPC Dashboard.skill` from the project owner's Downloads.
  It is a ZIP skill package, not a package to install into UPRIVER. It accepts
  a manually exported Amazon Sponsored Products Search Term Report (`.xlsx`)
  and produces a standalone HTML dashboard; no code was copied into UPRIVER.
- **Useful future feature:** add a native, shared **Search-Term Intent Analyzer**
  to the existing PPC Performance report. Its model classifies each term on
  independent `tier`, `stage`, `theme`, and `polarity` axes; uses account
  n-grams rather than a hard-coded taxonomy; compares exact intent with
  broad/auto/phrase discovery; validates whether expected higher-intent tiers
  really have higher CVR; flags no-order mismatch terms; and shows unclassified
  spend plus overlapping-rule diagnostics.
- **Important implementation decision:** intent rules must be account-specific,
  user-reviewed and versioned in Supabase. Do not automatically label customer
  terms or apply negatives/bids. Keep this feature read-only and offer evidence
  only, consistent with UPRIVER's existing PPC rules.
- **DataDoe scope is preserved:** UPRIVER's `Search Term Performance` source
  contains Sponsored Products and Sponsored Brands only, never Sponsored
  Display. Any intent view must label that coverage explicitly and must
  recompute CTR/CVR/ACoS from summed values, never average ratios.
- Existing PPC already supplies the prerequisite persisted search-term history,
  campaign/ASIN/target views, multi-currency separation, and wasted-spend
  safeguards. The skill is therefore a design and methodology reference, not a
  replacement for the current shared multi-user dashboard.

## Shared Data Persistence Fix (2026-08-02)

- **Root cause confirmed:** Supabase contained saved snapshots only for the six
  newer insight reports (`Sales Movers`, `Listing Health`, `Buy Box Loss`,
  `Returns`, `PPC`, `Listing Optimizer`). The original Dashboard, Daily
  Reporting, FBA Shipment Plan, Reconciliation, SKU P&L, Keyword Rank,
  Content Alerts, account directory, and Brand View still used each browser's
  `localStorage`/IndexedDB only. A second user therefore saw no saved data and
  had to refresh DataDoe again.
- **Fix implemented:** those legacy routes now use the same server-side
  `report_snapshots` contract: ordinary opens read Supabase only; explicit
  Refresh claims a cross-user database lock, calls DataDoe once, saves the
  result, and releases the lock. Brand View refreshes each account sequentially
  into that account's shared Dashboard snapshot; all users then build the same
  portfolio view from those snapshots without another export.
- The account directory and portfolio Brand Directory are also shared. Account
  responses are filtered after the shared read, so a user only receives their
  assigned Amazon accounts. Brand-directory access is authorised before every
  shared read.
- The API now prefers `SUPABASE_SERVICE_ROLE_KEY` when available and falls
  back to `SUPABASE_SECRET_KEY`. A live read-only Supabase check succeeded and
  confirmed the existing snapshot table/migration is healthy.
- Browser storage remains a fast/offline fallback only; it is no longer the
  authority. The selected-account Brand dropdown also includes brand names from
  the current in-memory shared snapshot, avoiding a missing dropdown after a
  fresh browser login.
- Verification required after deployment: refresh one selected account/report
  as User A; sign in as User B with access to that account; open the same report
  without pressing Refresh. It must show the saved timestamp/data and produce
  no DataDoe export.
- **Production deployed:** 2026-08-02 to
  https://upriverdashboard.vercel.app (Vercel deployment
  `upriver-dashboard-4l1eglk3h-laxmikant1604s-projects.vercel.app`). The
  stable URL returned HTTP 200 and served the new frontend bundle.

## External reference review (2026-08-02)

- The GitHub [`seller-dashboard` topic](https://github.com/topics/seller-dashboard)
  is a collection of unrelated repositories, not a repository, package, or
  integration that can be added to UPRIVER.
- Its current prominent entries are generic multi-vendor e-commerce products
  (for example Noqta Marketplace, Django/MERN marketplace apps, and storefront
  admin panels), rather than Amazon Seller Central/DataDoe analytics tools.
- Do not copy or adopt the topic wholesale. Review an individual candidate for
  licence, maintenance, framework fit, security, and its data model before
  borrowing a specific pattern. UPRIVER's existing React/Vite, Vercel,
  Supabase, authentication, access controls, caching, and DataDoe integration
  remain the source of truth.
- No application code changed as part of this reference review.

## MANDATORY RULE FOR ALL FUTURE REPORTS — use the shared design system

Every current and future report must be built from the shared visual system in
`sales-dashboard-live/src/styles/theme.js` and the shared components in
`sales-dashboard-live/src/components/`. This is not a style preference; it is the
reason a single token change restyles all fourteen report views at once.

- **Never** hard-code a colour, radius, shadow or spacing value in a view. Use
  the tokens (`--bg-app`, `--bg-surface`, `--bg-elevated`, `--border-default`,
  `--border-hover`, `--text-primary`, `--text-secondary`, `--text-muted`,
  `--accent`, `--accent-soft`, `--positive`, `--negative`, `--warning`,
  `--info`, `--radius-sm/md/lg`, `--shadow-sm/md`, `--space-1..6`). If the
  system lacks something, add the token to `theme.js` — do not localise it.
- Charts must take their colours from the exported `CHART` object in `theme.js`
  (recharts needs literal values, so it cannot read CSS variables).
- Compose from the shared patterns rather than new markup: `AppShell`/`Sidebar`/
  `TopBar`/`AccountSelector`/`BrandSelector`/`DateRangeSelector`
  (`src/components/shell.jsx`); `MetricCard`, `ComparisonMetric`,
  `TrendIndicator`, `Sparkline`, `ChartCard`, `ChartTooltip`, `BreakdownCard`,
  `ContributionBar`, `MetricTooltip`, `StatusBadge`, `DataQualityAlert`,
  `SkeletonCard`/`SkeletonMetricGrid`/`SkeletonChart`/`SkeletonTable`,
  `EmptyState`, `ErrorState`, `SegmentedControl` (`src/components/ui.jsx`); and
  the report shell helpers in `src/views/shared.jsx`.
- Tables use the shared table system: `plan-scroll` + `plan-table` (or
  `recon-table-scroll` + `recon-table`), a sticky `thead`, a sticky `pt-id`
  identity column, right-aligned tabular numerals, `min-width` on the table so
  horizontal scrolling stays **inside** the container, and `recon-pagination`
  for paging. A report must never make the page itself scroll sideways.
- Light theme only. Do not add a dark mode or a theme toggle.
- Data honesty rules are enforced by the components and must be preserved: an
  unknown value renders as an em dash and never as zero; a trend or sparkline is
  omitted entirely when the earlier period does not exist rather than drawn from
  a guess; money always carries an explicit currency and is never converted or
  combined across currencies.
- Only an explicit manual Refresh may call DataDoe. Navigation, account/brand
  changes, date filters, sorting, search and pagination stay local.

## Multi-DataDoe connection readiness (2026-07-31)

The current deployment has **one** server-side DataDoe connection:
`DATADOE_API_KEY`. All DataDoe API routes and the Ads scheduler use that single
key, so adding a second DataDoe organisation by changing the environment value
would replace the first connection; it would not merge the two safely.

Supporting another DataDoe account is feasible and should be implemented as a
small connection layer before any second key is added:

- store a server-only connection record for each DataDoe organisation;
- associate every discovered `seller_or_vendor_id` with exactly one connection;
- select the correct key server-side for every export, account discovery and
  scheduled Ads sync;
- namespace shared snapshots/cache keys by connection as well as account, and
  reject duplicate/unassigned account IDs instead of guessing;
- keep both keys out of the browser, source code, logs and `PROJECT_MEMORY.md`.

For a fixed two-organisation setup, separate Vercel environment variables can
temporarily hold the keys. For an admin-managed, scalable setup, use encrypted
server-side connection records and an admin-only connection screen. Existing
user-to-Amazon-account permissions continue to apply after connection mapping;
they should never grant access merely because a second DataDoe organisation was
added. The dashboard owner later reported adding the secondary Vercel variable;
its presence and the second organisation's live account list still require the
production check recorded below.

### Two-connection implementation (2026-07-31; deployed)

The report API and automated Ads worker now support the existing primary
DataDoe organisation plus an optional second one configured as the sensitive
Vercel variable `DATADOE_API_KEY_SECONDARY`. The browser never receives either
key.

- Existing primary account IDs remain unchanged, preserving current user
  permissions, browser caches, Supabase snapshots, COGS overrides and Ads
  history. Secondary account IDs use the stable prefix `dd-secondary:`. The
  shared account selector labels secondary entries `Secondary DataDoe` so two
  similarly named stores can be distinguished.
- `/api/datadoe?action=accounts` discovers and merges accounts from every
  configured connection. Each account-scoped report resolves its selected
  public account ID to one key plus its raw DataDoe seller/vendor ID before
  exporting. It intentionally rejects a request containing accounts from more
  than one organisation: DataDoe exports must not mix credentials or data.
- Returned secondary rows are rewritten to their public prefixed account ID,
  which keeps dashboard aggregation, local filters and cache keys consistent.
  Insight-report snapshots use the public ID, while their live DataDoe exports
  still use the raw ID. PPC's persisted Ads history also uses the public ID.
- Scheduled Ads sync now discovers, partitions and exports accounts per
  connection, then saves secondary records under their prefixed ID. The same
  country cron jobs cover both organisations; no additional cron functions are
  required. A repeated API key or the same raw Amazon account appearing in both
  connections fails closed instead of duplicating sales or advertising data.
- The outstanding redesign review findings are fixed: date presets now use a
  truthful button group with `aria-pressed` rather than an incomplete ARIA
  radio group, and the Sales Trend tooltip preserves valid zero unit/order
  values while still omitting fields that a source did not provide.

**Verification completed locally:** server modules pass `node --check`; `npm
run verify` passes **53 assertions** (including primary ID preservation,
secondary row namespacing and mixed-organisation rejection) and compiles the
full application bundle. The secondary Vercel variable was reported added by
the dashboard owner, but its value was intentionally not read or logged.

**Deployment verification:** feature commit `a553c27 Support secondary DataDoe
account sync` is pushed to `origin/main` and deployed through the stable alias
`https://upriverdashboard.vercel.app`. The production HTML now serves bundle
`assets/index-D2gD8Dl7.js`; the protected `/api/datadoe?action=accounts` route
returns HTTP 401 without a Supabase session, confirming the deployment remains
protected and no API key is exposed.

**Required signed-in production check:** sign in as the administrator,
hard-refresh once, confirm the Account selector includes the secondary
organisation's accounts, select one of them and use manual Refresh on a report.
The next existing country-specific Ads cron then seeds that organisation's Ads
history; do not expose `CRON_SECRET` merely to force it manually. If an Amazon
account appears in both DataDoe organisations, remove one copy in DataDoe
before using the dashboard; the API will display a safe duplicate error rather
than double count it.

### Account-directory refresh follow-up (2026-07-31; deployed)

The dashboard intentionally opens from its cached account directory, so a new
DataDoe organisation does not appear merely from a hard refresh. This protects
the existing cache-first/no-automatic-DataDoe-fetch rule, but it made a newly
added secondary connection hard to discover. The header Account control now has
an adjacent icon-only **Refresh account list** button. It calls only the merged
`accounts` endpoint when explicitly clicked; it does not refresh reports or
fetch sales/Ads data. Administrators then see the new account(s) immediately;
non-admin users still need the administrator to assign each new account in User
Access.

Commit `67f0d68 Add manual account directory refresh` is pushed to `main` and
live at `https://upriverdashboard.vercel.app`; production serves
`assets/index-BxxvG0Yk.js` and the protected account API still returns HTTP 401
without a signed-in user. The administrator must now use the new header icon to
perform the authenticated merged-account check.

## Frontend redesign — premium light-theme workspace (2026-07-30, deployed)

The whole frontend was redesigned into a light-theme Amazon seller command
centre. **No business logic, calculation, API, route, permission or caching
behaviour was changed.** The work was presentation plus the two interaction
defects noted below.

### New files

- `sales-dashboard-live/src/styles/theme.js` — the entire design system as one
  token-based stylesheet, exported as `STYLE`, plus the `CHART` colour object.
  It replaces the ~340-line inline `STYLE` template literal that used to live at
  the bottom of `App.jsx`. Every screen still renders `<style>{STYLE}</style>`,
  so the import is a drop-in and the login/loading screens are styled too.
  Three surface levels only: `--bg-app` (canvas), `--bg-surface` (panels),
  `--bg-elevated` (KPI cards, dropdowns, interactive controls). Depth is 1px
  borders plus soft ambient shadows; transitions are 150–250 ms.
- `sales-dashboard-live/src/components/ui.jsx` — the reusable primitives listed
  in the rule above. They take pre-formatted values, so report calculations stay
  in the report.
- `sales-dashboard-live/src/components/shell.jsx` — `Sidebar`, `TopBar`,
  `AccountSelector`, `BrandSelector`, `DateRangeSelector`, and the `NAV_GROUPS`
  navigation model. Presentation only: every piece of state stays in
  `DashboardApp`.

### Changed files

- `sales-dashboard-live/src/App.jsx` — inline stylesheet removed and imported;
  sidebar and header markup replaced by the shell components; the dashboard view
  rebuilt on the new primitives; hard-coded chart hex values replaced with
  `CHART`; loading/empty/error states added.
- `sales-dashboard-live/index.html` — title is now
  `UPRIVER — Amazon Seller Analytics`; the Manrope + JetBrains Mono webfonts moved
  from a CSS `@import` inside the injected `<style>` to `<link rel=preconnect>` +
  `<link rel=stylesheet>` in `<head>`, so the browser starts fetching them during
  HTML parse instead of after the stylesheet evaluates. Added
  `color-scheme: light` and a `theme-color`.
- `sales-dashboard-live/src/views/shared.jsx` — the one inline amber banner style
  became the shared `alert warning` class. Nothing else changed; the six insight
  reports inherit the redesign through the shared class names.

### Palette (light only)

Cool-neutral canvas `#F3F5F9`, white surfaces, near-navy text `#111A2E`. The
interactive accent is a confident blue (`--accent #2C5FD6`) used for active nav,
selected controls, focus rings and the primary chart series. **UPRIVER gold
(`--brand #E0982A`) is now a controlled brand accent only** — the logo tile, the
workspace crumb and the Daily Reporting MTD column — instead of colouring the
whole UI. Green/red/amber/blue keep their semantic meanings. Text contrast was
measured and tuned: primary ≈15.5:1, secondary `#4E5769` ≈6.9:1 and muted
`#6B7488` ≈4.6:1 against white, so every text level clears WCAG AA.

### App shell

- **Sidebar**: 236 px expanded, 68 px collapsed, smooth width transition. All
  fifteen destinations are preserved with unchanged `view` keys and route
  behaviour, now grouped for scanning as Overview / Finance / Operations /
  Growth / Monitoring / Admin. The active item uses a subtle accent background
  plus a slim 3 px accent indicator, not an oversized pill. Collapse and Sign
  out remain at the bottom. Collapsed items rely on native `title` tooltips
  deliberately: a CSS popover would be clipped by the rail's own vertical scroll
  container.
- **Mobile**: off-canvas drawer with a backdrop, a close button, and Escape to
  dismiss. The Collapse toggle is hidden on mobile because it has no meaning
  there.
- **Top command bar**: breadcrumb `UPRIVER · Amazon Seller Portfolio › <page>`
  on the left; Account selector, Brand selector and the refresh status cluster
  (label, live/idle dot, last-refreshed time, account name, Refresh button) on
  the right. The selectors are still native `<select>` elements — keyboard and
  mobile behaviour and the exact change semantics are unchanged — wrapped in a
  labelled icon+label+value+chevron control that truncates instead of
  overlapping.

### Main dashboard

Information architecture preserved exactly: header → global date filter →
data-quality alert → primary KPIs → performance comparisons → Sales Trend →
Sales by Account → Sales by Brand.

- **Date filter**: a compact segmented radio group (Yesterday / 7D / 30D / 90D /
  MTD / YTD / Custom) with the resolved range shown beside it. Preset maths,
  custom inputs and min/max clamping are the existing logic.
- **Data-quality alert**: the real unpriced-units warning is now a compact warm
  amber alert with a short headline plus detail, sized so it cannot outweigh the
  KPIs it qualifies.
- **KPI cards**: small label, dominant tabular-numeral value, `translateY(-2px)`
  hover with a slightly stronger border and shadow. **New, and computed only
  from the same cached rows:** a period-over-period change against the
  immediately preceding window of equal length, and a tiny SVG sparkline of the
  real per-day series. Both are withheld — not zeroed — when the earlier period
  starts before the first date this scope actually reported, and the sparkline
  renders nothing below three real points. Orders and Average Order Value still
  show an em dash when the source reports no order count.
- **Comparisons**: DoD / WoW / MTD / YoY as compact cards with period label,
  percentage, direction arrow and comparison basis. Direction is never colour
  alone — every value carries an arrow and an explicit sign.
- **Sales Trend**: the analytical centrepiece in a larger `ChartCard`. Same real
  data and the same Daily/Weekly/Monthly tabs; subtle area gradient, dashed
  hover crosshair, highlighted active point, and a custom tooltip that shows
  Date, Sales and — only when the source actually supplied them — Units and
  Orders. Trend buckets now also carry units/orders for that tooltip. Animation
  runs on data change only and is disabled entirely under
  `prefers-reduced-motion` (recharts animates in JS, so it is told separately
  via a `matchMedia` hook).
- **Sales by Account / Brand**: one visual language — name, sales value,
  contribution percentage and a horizontal contribution bar, aligned rows,
  `Unassigned` deliberately muted. Currency comes from the selected marketplace;
  INR is not hard-coded anywhere.

### States

Skeletons whose geometry matches the real content (metric grid, chart bars,
table rows), plus distinct honest states for: no account selected, nothing saved
for this account yet, saved but no sales in this range, nothing to plot, and a
real upstream failure showing the verbatim message with a retry action. A new
shared `SnapshotGate` renders exactly one of error / skeleton / "nothing saved
yet" for the five cache-first reports. **A cache miss is no longer a red error
banner** — it is a first-run empty state with a Refresh action, tracked in
`rowsCacheMissing` / `snapshotNotice` separately from real errors. Daily
Reporting no longer renders its matrix when nothing is saved, because that
printed a full grid of zeroes that looked like genuinely reported sales.

### Two interaction defects fixed (both were open follow-ups in this file)

1. **Duplicate manual refreshes.** The header Refresh button is now disabled for
   every view while that view's own request is in flight, and `fetchRows`,
   `fetchDaily` and `fetchPlan` gained in-flight guards. Repeated clicks could
   previously launch concurrent 25–45 s DataDoe exports for the dashboard, Daily
   Reporting and the FBA plan, spending quota twice.
2. **Mobile page overflow.** The seven-preset date control forced the whole page
   36 px wider than a 390 px viewport, because flex items default to
   `min-width:auto`. The row and the control can now shrink, so the control
   scrolls inside itself and the page never scrolls sideways.

### Verification actually performed (2026-07-30)

- `npm run verify` — **50 insight assertions pass**, and `build:check` produced a
  1,057 kB bundle with the expected >500 kB chunk warning, proving the full app
  compiled rather than being tree-shaken away.
- **Browser verification, which this file previously listed as the highest-value
  outstanding check, is now done.** A temporary local harness (`devpreview.html`
  + `src/devpreview.jsx`, both deleted before commit, plus a temporary export of
  `DashboardApp` that was reverted) seeded the browser cache the app already
  reads on open and rendered the real `DashboardApp`, so the redesign could be
  driven in Chrome via Playwright without production Supabase credentials. The
  seeded numbers were synthetic and existed only in that throwaway harness; no
  mock data exists in the application.
  Swept at **1440, 1180, 860 and 390 px**, and at every viewport: every one of
  the fifteen navigation destinations was opened, all seven date presets plus the
  custom range exercised, all three granularities switched, the chart hovered,
  and the brand filter applied and cleared. Result: **zero page-level horizontal
  overflow at any viewport, zero console or page errors, and zero `refresh=1`
  requests** from navigation, brand changes, date changes, granularity changes or
  sorting. Confirmed rendering: 4 KPI cards, 4 comparison cards, 4 sparklines,
  15 nav items, the chart and its hover tooltip, and the brand filter narrowing
  the brand breakdown from 5 rows to 2 locally. The mobile drawer opens from the
  menu button and closes with Escape; the collapsed desktop rail measures 68 px.
  Report tables scroll inside their own container with the sticky identity column
  intact.
- Note on the shared-report requests seen during the sweep: opening one of the
  six insight reports does issue a `/api/datadoe` request **without** `refresh=1`.
  That is the documented shared-snapshot read, which never touches DataDoe, and
  it is unchanged by this work.

### Deployment (2026-07-30)

Commit `7bee6ac Redesign frontend as a light-theme analytics workspace` pushed to
`origin/main` and deployed to production from the repo root with the Vercel CLI:
deployment `dpl_7rYzRqwL6sFxxUgmUekP3ecU1EXr`
(`https://upriver-dashboard-iy9uacrxr-laxmikant1604s-projects.vercel.app`),
`readyState: READY`, aliased to `https://upriverdashboard.vercel.app`.

Post-deployment verification: the production alias returned **HTTP 200**; the
served HTML carries the new `UPRIVER — Amazon Seller Analytics` title, the
`color-scheme: light` hint and the webfont `<link>` tags; the served bundle
(`/assets/index-DPdRMajb.js`) contains the redesign markers `sb-group-label`,
`crumb-current`, `refresh-cluster`, `metric-spark`, `chart-tip-swatch`,
`--bg-elevated` and "Nothing saved for this account yet". Access control is
unaffected: `/api/datadoe?action=accounts` without a Supabase token still returns
**HTTP 401**, and `/api/access?action=bootstrap-status` still returns
`{"initialAdminExists":true,"confirmationPending":false}`. The bare deployment
URL returns 302 (Vercel deployment protection on the non-aliased host), which is
the project's normal behaviour — verify through the alias.

### Independent Codex review (2026-07-31; no production change)

`npm run verify` was independently rerun after the deployment: all 50 insight
assertions passed and the full 1,057 kB application bundle compiled. The public
production alias was also checked: it returns the new light-theme sign-in page
with the expected title and authentication controls. Authenticated report data
was not inspected in this review because no production user session was used.

Two polish fixes remain before describing the redesign as fully accessibility-
and data-display-complete:

1. **Date range keyboard semantics:** `DateRangeSelector` in
   `src/components/shell.jsx` uses `role="radiogroup"` and `role="radio"`, but it
   does not implement the required Arrow-key/roving-tabindex behaviour of an
   ARIA radio group. Either implement that keyboard model or change the wrapper
   to a neutral `role="group"` and retain ordinary buttons. Do not leave a
   keyboard-incomplete radio pattern.
2. **Chart tooltip zero values:** `DashboardApp` builds trend buckets with
   `units: 0` and `orders: 0`, then only renders a tooltip row when each value is
   truthy. A genuine zero-unit/zero-order bucket is therefore hidden, and the
   bucket has no field-presence flag to distinguish an unavailable metric from
   a real zero. Preserve `hasUnits`/`hasOrders` while aggregating rows and use
   those flags when rendering the tooltip. This keeps the product rule that
   unknown values are omitted without hiding real zero values.

These are review findings only. No application code or deployment was changed
on 2026-07-31; the live alias remains the deployment recorded above. Resolve
the two items in a focused follow-up, rerun `npm run verify`, perform a
signed-in browser check, then deploy and update this section with the commit.

### Remaining limitations

- The six insight reports, Reconciliation, SKU P&L, FBA plan, Keyword Rank and
  Content Alerts inherit the redesign through the shared class names and were
  verified for layout, overflow and their empty/error states, but **not with real
  populated data in a browser**, because that needs a signed-in production
  session. Their table markup and calculations were not touched.
- No screenshot was attached to the redesign request in the session that
  produced this work, so the layout follows the written specification (refined
  sidebar, command-bar header, compact filters, strong KPI hierarchy, main chart,
  two-column breakdown) rather than a pixel reference.
- The bundle is still a single ~1,057 kB chunk. Code-splitting recharts and the
  report views behind dynamic imports remains the obvious performance follow-up.
- `sales-dashboard-live/datadoe (1).js` and the diagnostic `?action=fields` /
  `?action=sample` routes are still present; unrelated to this work.

## Six insight reports — built on branch `feature/six-insight-reports` (2026-07-29, NOT deployed, NOT merged)

All six approved read-only modules are implemented on the branch
`feature/six-insight-reports` (base `main` at `497c7cc`). **Nothing was merged to
main and nothing was deployed**, as instructed. Codex review is the next step.

### Commits, in phase order

| Commit | Phase |
| --- | --- |
| `1c3eb22` | Insight engine + Sales Movers + Listing Health + Buy Box Loss |
| `1278c05` | Returns & Refund Leakage |
| `626280e` | PPC Performance & Wasted Spend |
| `78658d1` | Listing & Search Optimizer |
| `a4d6f7d` | Cross-report Priority Feed |
| `ad39fc4` | Senior-review fixes (currency mixing, truncation, midnight-blank reports) |

### New and changed files

New server modules:
- `lib/server/datadoe.js` — the DataDoe transport, extracted from
  `api/datadoe.js` so all thirteen reports share one 2-req/sec rate limiter, one
  export poller, one row-cap policy and one set of UTC date helpers. Adds
  `fetchExportRowsStrict`, which refuses a result sitting on the row cap.
- `lib/server/report-store.js` — the shared snapshot contract (below).
- `lib/server/reports/sources.js` — every source id, column, grain, default-
  enablement flag and fetch window, validated against the live data scheme.
- `lib/server/reports/common.js` — catalog map, source freshness, FBA snapshot.
- `lib/server/reports/{sales-movers,listing-health,buy-box,returns,ppc,listing-optimizer}.js`

New client modules:
- `src/lib/format.js`, `src/lib/csv.js` — display and CSV helpers moved out of
  `App.jsx` so the report views format money, dates and units identically.
- `src/lib/insights.js` — the Insight Engine and all six reports' rule sets.
- `src/views/shared.jsx` — report shell, freshness strip, Priority Actions,
  insight card, sortable header, pagination, currency-scope helpers.
- `src/views/{SalesMovers,ListingHealth,BuyBoxLoss,ReturnsLeakage,PpcPerformance,ListingOptimizer,PriorityFeed}.jsx`

Changed: `api/datadoe.js` (imports the shared transport; six new actions),
`lib/server/supabase.js` (`releaseRefreshLock`, `getLatestReportSnapshot`,
`getAdsDailySourceRows`), `lib/server/ads-sync.js` + `api/cron/[scope].js` +
`vercel.json` (search-terms Ads source, 16 crons), `src/App.jsx` (seven sidebar
items, shared-report data layer, insight CSS), `package.json` (scripts).

### Non-negotiable architecture — how each rule is met

- **Shared Account/Brand scope only.** No report has a page-level account or
  brand selector. Brand filtering is applied client-side in every builder, and
  each payload returns `catalogBrands` so the header selector works from these
  reports alone.
- **Server-enforced permissions.** `getDashboardAccess(req)` runs before any
  branch in `api/datadoe.js`; all six actions are in `ACCOUNT_SCOPED_ACTIONS`, so
  `assertAccountAccess` rejects an account the user is not assigned. Each action
  additionally requires exactly one account id.
- **Only Refresh calls DataDoe.** A request without `refresh=1` reads the saved
  Supabase snapshot and never touches DataDoe. Navigation, brand changes,
  filters, search, sorting, paging, level tabs, the Buy Box threshold and the PPC
  break-even input are all local recomputation.
- **Shared snapshot + refresh lock.** `serveSharedReport` claims
  `claim_report_refresh_lock` before any export, so two people pressing Refresh
  cannot spend DataDoe tokens twice; the validated payload is saved to
  `report_snapshots` for every permitted user and a compact `dashboard_events`
  row is published. The lock is released in a `finally`, so a failed refresh does
  not block retries. There is also a client-side in-flight guard per report.
- **PPC reads persisted Ads history.** Every advertising figure comes from
  `ads_daily_source_rows`. No Ads export runs from the report path at all, even
  on Refresh. The only DataDoe call PPC makes is one small total-sales export for
  TACoS, and losing it degrades TACoS to unavailable without breaking the report.
- **Currencies stay separate.** Nothing converts. Combined money totals render an
  em dash when a scope holds more than one currency, per-row money keeps its own
  currency, and the Priority Feed groups by currency and never adds across them.
- **No summed percentages.** ACoS, TACoS, CTR, CVR, CPC, ROAS, conversion,
  margin, return rate, impression share and Buy Box share are all recomputed from
  summed numerators and denominators.
- **No fake zeroes.** Unknown values render as an em dash. A missing snapshot, a
  disabled source, a missing FBA snapshot, an unseeded Ads account and a lagging
  sales source each have their own explicit state.
- **Read-only.** No Amazon write action, bid change or negative keyword anywhere.

### Sources used, all validated against the live data scheme on 2026-07-29

Validated against `https://api.datadoe.com/api/v1/spec/data-scheme` (public,
unauthenticated). `default:false` tables are not enabled for every organisation
and every such export is wrapped to return an actionable Settings > Data tables
message instead of a server error.

| Table | Full id | default | Used by | Documented window |
| --- | --- | --- | --- | --- |
| `amazon_sales_and_traffic_with_cogs` | `401ffcd7e50c1ea9a18cacf221ddf99858db20a0f31eff65fc22a8e8140c7e1b` | yes | Movers, Returns rate, PPC TACoS | INITIAL 35 / DAILY 4 / MONTHLY 30 |
| `amazon_profit_by_sku_and_date` | `57a0cb31...` | yes (premium) | Buy Box, Listing Health, Movers ads | CONTINUOUS, intraday |
| `amazon_listings_with_cogs` | `ba689c05...` | yes (premium) | Listing Health | CONTINUOUS, no date column |
| `amazon_listings_raw` | `6ea445cdc459f9fbb9517c5c009384da60ef31a1e70d4de9187ea3d4c28535c4` | **no** | Listing Health issue codes (optional) | CONTINUOUS, no date column |
| `amazon_fba_inventory_health` | `44fc5ba0...` | yes (premium) | Buy Box prices, Movers stock, Listing Health | INITIAL 1 / DAILY 1 (snapshot only) |
| `amazon_returns` | `27c6fc0ec69648b5fed4612dbd9ccdfdeaaca6787f8f985c01266e4dc11f9038` | yes | Returns reasons | INITIAL 60 / DAILY 60 |
| `amazon_settlements_with_cogs` | `732dac68...` | yes | Returns money | INITIAL 730 / DAILY 21 |
| `amazon_products_by_child_asin` | `68d2de23...` | yes | all (brand), Optimizer (content) | CONTINUOUS, no date column |
| `amazon_ads_performance_by_campaign_by_date` | `08cdc77d...` | yes | PPC campaigns | 56 / 21 / 49 |
| `amazon_ads_performance_by_child_asin_and_date` | `d0017e92...` | yes | PPC ASINs (same-SKU attributed) | 60 / 21 / 49 |
| `amazon_ads_targeting_by_campaign_by_date` | `bbba3d21...` | **no** | PPC targets (**SP + SB + SD**) | 56 / 21 / 49 |
| `amazon_ads_search_terms_by_campaign_by_date` | `e94e9671989ce4aa2814ac729807c7ddcc1cc47a71ebcd75d9fe661ed80335be` | **no** | PPC search terms (**SP + SB only**) | 60 / 21 / 49 |
| `amazon_child_product_organic_search_ranks_per_week` | `81aa5b4c...` | **no** | Optimizer | INITIAL 21 / WEEKLY 7 |

Newly discovered facts worth keeping:
- `amazon_returns` has **no quantity column and no currency column**, and
  `amazon_return_refunded_amount` / `amazon_return_label_cost` exist for **FBM
  returns only**. One row is one returned item. All refund money therefore comes
  from settlement REFUND rows, which cover FBA and FBM and carry a currency.
- `amazon_sales_and_traffic_with_cogs` has **no currency column**; its money is
  in the account's currency.
- `amazon_products_by_child_asin` has **no `seller_or_vendor_id` column** — it is
  marketplace-level and filtered by the export's account ids.
- `amazon_listings_with_cogs.listing_status` is the enum `Active / Inactive /
  Incomplete`, and `listing_fulfillment_channel` is `DEFAULT` (= FBM) /
  `AMAZON_NA` / `AMAZON_EU` / null.
- Buy Box share has **no dedicated table**. `buybox_percentage` lives on
  `amazon_profit_by_sku_and_date` at SKU/day grain.

### Formulas and rules per report

**Sales Movers.** Two equal 7-day windows, both ending at the latest date Sales &
Traffic actually reported units (never today, because that source's recurring
window is 4 days). Because `sales = sessions x (units/sessions) x (sales/units)`,
the change is split exactly into a traffic effect, a conversion effect and a price
effect that sum to the total change; the dominant driver is the largest of the
three. An ASIN with no sessions or no units in either week shows **Not
attributable** instead of a guessed driver. Buy Box is deliberately not diagnosed
here (it needs a page-view-weighted average of daily rows). A uniform,
traffic-shaped collapse across most of the catalogue triggers a data-completeness
warning instead of a page of false alarms.

**Listing Health.** Gates in order: reported ERROR issue, missing
buyable/discoverable flag, `Inactive`, `Incomplete`, stock on hand with no active
or buyable offer (stranded), Active with no price, then WARNING/INFO. Ranked by
trailing 30-day `total_sales` for that SKU — money that stops, not a forecast.
Units on hand uses the FBA snapshot for FBA offers and the merchant quantity for
FBM offers and **never adds them**, because they are two views of the same stock.
Without the non-default raw-issues table nothing is labelled Suppressed.

**Buy Box Loss.** 28 days of raw daily rows in 7-day slices (rejecting any slice
that hits the cap), folded into a **page-view-weighted** Buy Box share so a
2-page-view day cannot count as much as a 2,000-page-view day. Days where Amazon
reported no featured-offer competition are **excluded**, not scored 0%, because a
sole seller has lost nothing. Sales at risk = `sales x (1 - share)`. Cause is
named only from present evidence: your price above `featuredoffer_price` is
Price; zero or near-zero `available` against the 30-day run rate is Stock; a
selling SKU with no FBA row at all is Fulfilment; otherwise **Unconfirmed** with
confidence dropped.

**Returns & Refund Leakage.** Ranked by money, not rate. Leakage = settled
customer refunds + seller-borne return fees (return commission + FBA
customer-return per-unit fee, less any restocking fee recovered, clamped at zero).
`COGS on refunded units` is displayed but **excluded**, because the source does
not say whether returned stock came back sellable. Rate is Amazon's own
`units_refunded / units_shipped`; when refunds exceed shipments inside the window
the returns belong to earlier sales, so the rate is withheld as **lag\*** rather
than shown above 100%. A cause is named only when one reason bucket is at least
half of that product's returns. Refunds are separated from pending and cancelled
activity structurally: a refund exists only once a REFUND settlement posts, a
cancelled order never settles, and a pending return shows as a pending request.

**PPC Performance & Wasted Spend.** Ads figures come only from Supabase.
**Dead spend** is the whole spend of a row with clicks and no attributed orders,
and only above a 10-click minimum. A **break-even breach** counts only the spend
*above* the break-even ACoS as wasted, because the sales up to that point are
still worth buying. Scaling candidates are separate opportunities. Coverage is
stated per level and Search Term results are never labelled as covering
Sponsored Display.

**Listing & Search Optimizer.** SQP reports both the ASIN's counts and the whole
query's totals, so "below market" is a measurement: impression share = your
impressions ÷ query impressions, and CTR/CVR vs market is your rate ÷ the same
query's rate. Gates in order: relevance guard (low share + both below market),
discoverability, exposure, click-rate, conversion. A query missing the market
denominators is left **unclassified**. Organic rank uses the **best** rank
observed, never an average. Title checks apply Amazon's published 2026 rules for
non-media categories (75 characters, no promotional words, no disallowed symbols,
no word more than twice). Insights carry **no money value**, because SQP reports
purchase counts and inventing a price would be fabrication.

**Priority Feed.** Re-derives the six reports' insights from the same snapshots,
dedupes repeats per (report, category, product) keeping the most severe, and
groups by currency. It deliberately does **not** merge across reports: a Buy Box
loss and a returns problem on the same ASIN are different problems with different
fixes.

### Verification actually performed

- `npm run test:insights` — **47 assertions pass** (`scripts/test-insights.mjs`),
  covering decomposition exactness, the no-averaged-ratios rule, gate ordering,
  evidence-gated causes, the click minimum, break-even partial waste, the
  currency-withholding fix, ranking, dedupe, CSV formula-injection escaping and
  em-dash-not-zero rendering.
- `npm run build:check` — clean build, ~1,010 kB bundle with the expected
  >500 kB chunk warning. New view strings confirmed present in the bundle.
- `node --check` on every server module; `import()` of `api/datadoe.js` to prove
  every import resolves; `vercel.json` parsed (16 crons).
- Access control audited in code: the auth gate is the first statement in the
  handler and all six actions are account-scoped.

**IMPORTANT — a build-verification gap was found and fixed.** `src/lib/supabase.js`
exports `supabase` as null when `VITE_SUPABASE_URL`/`VITE_SUPABASE_PUBLISHABLE_KEY`
are absent, and `App.jsx` then returns an early "Login setup incomplete" screen.
Vite inlines `import.meta.env` at build time, so in a workspace without those
variables Rollup proves `supabase` is null and **dead-code-eliminates the entire
dashboard** — LoginScreen, DashboardApp, every report view, recharts and
lucide-react. A plain `npm run build` produced a ~180 kB bundle with no chunk
warning while compiling almost none of the app. Any past "npm run build passed"
claim made in a workspace without those variables verified very little. Use
`npm run build:check` (or `npm run verify`), which injects placeholder public
values; a bundle well under ~900 kB, or a missing chunk warning, means the app was
tree-shaken away and the build did not verify it.

### Senior self-review — defects found and fixed in `ad39fc4`

- **Currency mixing (correctness).** The Movers advertising export is grouped by
  `child_asin` AND `currency` but was folded on ASIN alone, adding two currencies
  into one spend number. Now withheld per ASIN with a `mixedCurrency` flag.
- **Currency mixing (presentation).** Combined money totals in Buy Box, Listing
  Health, Returns and PPC summed across currencies. Now an em dash plus an
  explanation via `moneyScope`/`totalMoney`.
- **Silent truncation.** The shared catalog and FBA snapshot reads were not
  strict. A truncated catalog silently drops brands and makes the header brand
  filter hide real rows; a truncated inventory snapshot makes an absent SKU look
  like zero stock and produces a **false stockout claim**. Both now reject.
- **Understated leakage.** The returns fee component could go negative when a
  restocking fee exceeded the return fees. Clamped at zero.
- **Reports blank every midnight.** Snapshot scope includes the as-of date, so the
  exact key stopped matching at midnight and all six reports looked unsaved. The
  server now falls back to the latest saved snapshot and the UI labels it as an
  earlier as-of date. This also resolves the long-standing FBA Shipment Plan
  stale-cache follow-up.
- **Wrong refresh target.** Refresh on the Priority Feed would have refreshed the
  main dashboard. Now disabled there with a tooltip.

### Open issues for Codex review

1. **No live DataDoe validation was possible from this workspace.**
   `DATADOE_API_KEY` is not present locally (`vercel env pull` at the repo root
   provides only the Supabase and Postgres variables), and production must not be
   deployed. So **no report has yet run against a real account**, and the
   requested IN and US account validation is outstanding. Every source id, column
   name, grain and window was validated against the public data scheme, and only
   export shapes already proven in this repo are used (`groupBy` + `sum`
   aggregations, plain column selects, `orderByColumn`, omitted from/to for
   date-less sources), but the first real refresh of each report still needs
   observing on a preview deployment.
2. **`aggregation: "avg"` was deliberately never used**, because it is unproven
   in this repo. That is why Buy Box fetches raw daily rows in slices. If a live
   test confirms DataDoe supports `avg`, Buy Box could collapse to one grouped
   export and lose most of its latency.
3. **Latency risk.** Buy Box runs 4 sliced exports plus a snapshot; Returns runs 3
   plus a catalog; Movers runs 6. `maxDuration` is 60 s. These need timing on real
   accounts, especially large catalogues; the observed 25–46 s of existing
   six-month reports suggests Movers and Buy Box are the ones to watch.
4. **16 cron entries** now exist (four Ads sources × four country scopes).
   Confirm this is within the Vercel plan's cron limit before deploying; the
   project previously had 12 registered.
5. **Search Term Ads history starts at first sync.** Adding
   `search-terms-performance-v1` means its 60-day initial seed only happens on the
   next scheduled run after deployment. Until then the PPC search-term level
   correctly reports no saved rows rather than zero spend.
6. **Browser-level verification is outstanding.** No Playwright runtime is
   available in this workspace, so mobile overflow, sticky identifier columns and
   the "zero DataDoe requests on navigation/filter/sort" behaviour were built to
   the proven existing patterns and reasoned through, but not observed in a real
   browser. This is the highest-value remaining check.
7. **Any authorised viewer can trigger a Refresh** and therefore spend DataDoe
   quota. This matches the existing reports' behaviour, but if refresh should be
   restricted to editor/admin, that is a one-line change in each action.
8. **Priority Feed is a seventh sidebar item.** Phase 5 asked for a global feed
   and it needed a home; flagging it against the "only the six requested sidebar
   items" instruction.
9. **`report_snapshots` growth.** Each report keeps one row per
   (report, account, params_hash) and the as-of date is part of the hash, so a new
   row accumulates per account per day. An 8 MB per-snapshot guard exists, but a
   retention job that deletes superseded snapshots is still needed to protect the
   Supabase free-tier 500 MB.
10. **Pre-existing cleanup, untouched:** the temporary `?action=fields` and
    `?action=sample` diagnostic routes remain in `api/datadoe.js`, and the stray
    `sales-dashboard-live/datadoe (1).js` file still exists.

### How to review

```
git checkout feature/six-insight-reports
cd sales-dashboard-live
npm run verify          # 47 assertions + a real (non-tree-shaken) build
```
Then deploy a **preview** (not production), sign in, and for one IN and one US
account press Refresh once per report, confirming: the shared snapshot is saved,
a second browser sees it without its own refresh, a concurrent Refresh is
rejected by the lock, and navigation/brand/filter/sort/paging produce zero
`/api/datadoe` requests.

## Operating rule

- Whenever a future assistant makes changes, completes a task, or learns important project context, update this memory/documentation before finishing.
- Keep this file useful for handoff between Codex, Claude, or another assistant: record completed work, current progress, pending tasks, important decisions, and technical learnings.
- Do not overwrite unrelated user changes. If the worktree has existing untracked or modified files, preserve them unless the user explicitly asks otherwise.

## Current project status

- Project root: `sales-dashboard-live`.
- App: PULSE, an Amazon Seller Portfolio Sales Dashboard.
- Frontend: React + Vite in `sales-dashboard-live/src/App.jsx`.
- Backend: Vercel serverless function in `sales-dashboard-live/api/datadoe.js`.
- Data source: DataDoe REST API, using a server-side `DATADOE_API_KEY`.
- Deployment target: Vercel. Pushing code to GitHub should trigger Vercel rebuild/redeploy.
- Critical Vercel setting: Settings -> General -> Root Directory must be `sales-dashboard-live`, because the project files are nested one folder deep.
- Production URL: https://upriverdashboard.vercel.app
- Local development command from the README: `npm install`, then `npm run dev`.

## Completed

- Initial project files exist for the Vite frontend, Vercel API route, package metadata, and README.
- `node_modules` and `dist` are present under `sales-dashboard-live`, suggesting dependencies have been installed and a production build has been generated at least once.
- Added this project memory file so future work has a durable handoff location.
- Fixed a DataDoe sales export failure caused by sending more than 5 `sellerOrVendorIds` in one export request. `sales-dashboard-live/api/datadoe.js` now chunks sales exports into batches of 5 and combines the returned rows.
- Vercel deployment is intended to auto-deploy from the main branch.
- Production deploy completed from the repo root with Vercel CLI on 2026-07-23. Deployment URL: https://upriver-dashboard-gchyci0gn-laxmikant1604s-projects.vercel.app. Production alias: https://upriverdashboard.vercel.app.
- Latest production deployment with account and catalog brand filtering completed on 2026-07-23. Deployment URL: https://upriver-dashboard-3xs64d4e1-laxmikant1604s-projects.vercel.app. Production alias remains https://upriverdashboard.vercel.app.
- Latest production deployment with Daily Reporting aggregation/freshness correction completed on 2026-07-24. Deployment URL: https://upriver-dashboard-ezelupb9z-laxmikant1604s-projects.vercel.app. Production alias remains https://upriverdashboard.vercel.app.
- Latest production deployment with Seller Central Order Report sales completed on 2026-07-24. Deployment URL: https://upriver-dashboard-e2wjkc6bn-laxmikant1604s-projects.vercel.app. Production alias remains https://upriverdashboard.vercel.app.
- Latest production deployment with header Brand Selection and Yesterday date filter completed on 2026-07-24. Deployment URL: https://upriver-dashboard-5flxvkird-laxmikant1604s-projects.vercel.app. Production alias remains https://upriverdashboard.vercel.app.
- Latest production deployment with cached Brand Selection enablement completed on 2026-07-24. Deployment URL: https://upriver-dashboard-avrphaoqk-laxmikant1604s-projects.vercel.app. Production alias remains https://upriverdashboard.vercel.app.
- Latest production deployment with selected-account refresh restriction completed on 2026-07-24. Deployment URL: https://upriver-dashboard-i5dly4pvv-laxmikant1604s-projects.vercel.app. Production alias remains https://upriverdashboard.vercel.app.
- Latest production deployment with SKU P&L Analyzer and Content Change Alerts completed on 2026-07-27. Commit `6391bd3` added both reports; commit `752d6d5` added an actionable disabled-source response for Content Alerts. Deployment URL: https://upriver-dashboard-aidb49f1v-laxmikant1604s-projects.vercel.app. Production alias remains https://upriverdashboard.vercel.app. Build and `node --check` passed; the homepage returned HTTP 200; Content Alerts returned the expected HTTP 424 setup message while its source is disabled and rejected a two-account request with HTTP 400 before DataDoe access.
- Latest production deployment with the standalone SKU P&L Brand-selector review fix completed on 2026-07-27. Commit `32f01da Populate brands from SKU P&L` returns distinct P&L brands with the selected account ID and hydrates the shared header selector after a P&L refresh. Deployment URL: https://upriver-dashboard-r3j0dajj1-laxmikant1604s-projects.vercel.app. The production alias https://upriverdashboard.vercel.app returned HTTP 200 after deployment.
- Latest production deployment with the unpriced-order-unit dashboard warning completed on 2026-07-27. Commit `d91951c Flag unpriced order units in dashboard` preserves `unpriced_units` from the Order Line Items response, shows a visible all-brand warning, and uses cache version `order-items-v2-quality`. Deployment URL: https://upriver-dashboard-btarbwi5i-laxmikant1604s-projects.vercel.app. Production verification for JustHuman IN / 2026-07-26 returned `INR 79,510` across 60 priced units and a separate 6-unit zero-value group; the production alias returned HTTP 200.
- Latest production deployment with longer DataDoe export polling completed on 2026-07-27. Commit `a03b90c Allow longer DataDoe export polling` changes the shared polling window from roughly 18 seconds to roughly 40 seconds at DataDoe's recommended five-second cadence. Deployment URL: https://upriver-dashboard-qfa5iuf09-laxmikant1604s-projects.vercel.app, aliased to https://upriverdashboard.vercel.app. A retried one-day JustHuman Sales & Traffic request completed successfully but returned no 2026-07-26 rows, confirming that the alternate source has not caught up and is not a safe fallback for this recent date.
- FBA inventory data-path audit completed on 2026-07-27. Account-level checks found complete current snapshots: JustHuman IN had 24 raw SKU rows and Indya Store IN had 207, both below the 15,000-row cap. Exact Amazon reconciliation for JustHuman `JH-100-PC-2` / `B08YGQJJ6D` exposed a source-field overlap: Amazon showed Available 48, Inbound 126, FC transfer 0, FC processing 12, and customer-order reserve 2, while DataDoe's 2026-07-27 row returned Available 50, `reserved_fc_transfer` 126, `reserved_fc_processing` 13, and `inbound_shipped` 126. The 126 shipment was being counted twice by the prior dashboard formula. The FBA plan now uses `max(0, reserved_fc_transfer - inbound_shipped)` for the FC-transfer reserve, retains In Transit from `inbound_shipped + inbound_received`, and uses cache version `fba-plan-v2-transfer-dedupe` so a manual refresh cannot reuse the old totals. The remaining 2 Available and 1 FC-processing difference is upstream snapshot timing/rounding; customer-order reserve remains intentionally excluded from shipment planning.
- Latest production deployment with the FBA transfer/inbound de-duplication completed on 2026-07-27. Commit `7975b33 Deduplicate FBA transfer inventory`; deployment https://upriver-dashboard-i8jytbo10-laxmikant1604s-projects.vercel.app is aliased to https://upriverdashboard.vercel.app. Production verification for JustHuman `JH-100-PC-2` / `B08YGQJJ6D` returned FBA Available 50, adjusted FC Transfer 0, FC Processing 13, Inbound Shipped 126, and Inbound Received 0, so the 126 shipment is no longer counted under both Reserved and In Transit.
- Latest production deployment with SKU P&L COGS overrides completed on 2026-07-27. Commit `40cb991 Add SKU COGS overrides`; deployment https://upriver-dashboard-h8i24ymu3-laxmikant1604s-projects.vercel.app is aliased to https://upriverdashboard.vercel.app. The COGS-column pencil opens an account/SKU/currency-scoped per-unit editor. Saving persists the browser-local override, recalculates COGS, total cost, profit, margins, statuses, KPIs, and CSV export without a DataDoe request; reset restores the DataDoe value. Production HTML served `index-D7OKhlGz.js` containing the `upriver-cogs-overrides-v1` marker.
- FBA Shipment Plan report built, reconciled, reviewed, and deployed to production on 2026-07-26. Commit `6ef64fb Add FBA Shipment Plan report` pushed to `origin/main`. Production deployment URL: https://upriver-dashboard-1a0pg1mq1-laxmikant1604s-projects.vercel.app. Production alias remains https://upriverdashboard.vercel.app. Deployed verification (Haven&Hue US, to=2026-07-26): 79 ASIN rows, 27 restock, AWD column shown, sales through 2026-07-24, FBA snapshot 2026-07-26; existing Dashboard (KPI cards, range chips) and Daily Reporting regression-checked OK; no console errors on desktop or mobile; no mobile page overflow. See the "FBA Shipment Plan report" section below for full source IDs, mappings, and reconciliation.
- Local commit `89c30f0 Batch DataDoe sales exports` was pushed to `origin/main` after clearing the stale cached GitHub credential.
- `DATADOE_API_KEY` is expected to be configured for Production, Preview, and Development in Vercel.
- DataDoe authentication is verified to use the custom `datadoe-api-key` header, not standard Bearer auth.
- DataDoe endpoint paths are verified as `/util/sellers-and-vendors` for accounts and `/exports` for export creation/data retrieval.
- Account list loading has worked with 15 accounts visible in dropdowns.
- Header UI updated: the top badge now reads `UPRIVER` instead of `PULSE`, and the account scope selector (`All Accounts`, `Single Account`, `Brand View`) moved into the header before the refresh/account status.
- Added browser-side DataDoe response caching in `src/App.jsx`. The app now hydrates accounts, dashboard sales, and Daily Reporting from `localStorage` on open/selection changes and does not call DataDoe automatically. Network calls happen only through explicit refresh buttons, which update the matching cache entry.
- Replaced the dashboard's `All Accounts` / `Single Account` / `Brand View` modes with a single Account Selection dropdown in the header and a Brand Selection dropdown below it. The brand dropdown includes `Select All Brands` and filters every dashboard KPI, comparison, trend, and breakdown locally from the cached response.
- Moved the dashboard Brand Selection dropdown into the header beside Account Selection. It is populated only from the selected account's cached catalog/sales response, resets to `Select All Brands` immediately on account changes, and never triggers a DataDoe request by itself. Added a `Yesterday` date-range chip; it uses the prior calendar day when present, otherwise the latest available source date to avoid an empty inverted range.
- Fixed the header Brand Selection control being disabled after the order-report cache version change. It now scans only browser-cached `brand-sales` catalog metadata for the selected account, so previously cached account brands remain selectable before a new manual refresh. The selector is always openable and does not call DataDoe.
- Dashboard refresh is now explicitly single-account: the browser passes only the selected account ID, `action=brand-sales` rejects multi-account IDs server-side, and the header status reports the refreshed account name instead of the total number of connected accounts. Daily Reporting follows the same selected-account status behavior.
- Production verification: a two-account `action=brand-sales` request returns HTTP 400 before DataDoe access; a one-account Indya Store request returned 11 rows, 35 catalog brands, and exactly one account ID.
- Replaced account-name heuristic brand grouping with DataDoe product-brand data. Dashboard refreshes now use the product-level sales source plus the Product Catalog by ASIN source, keeping all DataDoe calls manual and caching both the sales rollup and catalog response per account/date range.
- Validated the deployed `action=brand-sales` route with a one-day AAKRITI request: it returned one grouped row per product brand/day and the catalog source returned real product-brand data. The API now returns only distinct `catalogBrands` to the browser rather than full product catalog records, avoiding oversized `localStorage` cache entries while retaining catalog-backed filtering.
- Final live payload check: the one-day AAKRITI request returned 2 grouped sales rows and 35 catalog brand labels; the compact response is suitable for the browser cache.
- Daily Reporting is now verified and corrected: it uses DataDoe server-side grouping for sales and advertising data, then anchors the visible table to the latest completed sales date. This prevents an incomplete current zero-sales source row from appearing as a genuine zero-sales day.
- Final daily live check after deployment: June 2026 is `₹633,481.37` sales, `467` units, `₹348,317.20` ad sales, `₹125,095.80` ad spend, and `26,703` clicks for AAKRITI ART CREATIONS IN. The latest completed sales date is 2026-07-22; the raw source has an incomplete 2026-07-23 sales row.
- Added a collapsible left sidebar shell around the existing dashboard in `src/App.jsx`. It has a brand/workspace header ("UR" logo, "Upriver Dashboard", `laxmikant@upriver.in`). Desktop supports a collapse button (icon-only mode); mobile/tablet uses an off-canvas drawer with a menu button, backdrop click, and close button. All existing filters, KPI cards, comparisons, chart, and breakdowns render unchanged inside the new `.main-area`. Icons use `lucide-react`.
- Added a "Daily Reporting" section as a second sidebar nav item. A `view` state (`"dashboard"` | `"daily"`) switches the main content; the account-scope tabs only show in dashboard view. The Daily Reporting view is single-account (defaults to Aakriti Art Creations, matched by name) with its own account dropdown and independent fetch (`dailyRows`, ~5 months of history via `action=daily`).
- Daily Reporting renders a table matching the user's screenshot: columns are 3 completed months + current-month MTD + the last 5 days (relative to the latest data date); rows are Total Sales, Ad Sales, Ad Spends, Clicks, Units, ROI (Ad Sales÷Ad Spend), ACoS % (Ad Spend÷Ad Sales), TACoS % (Ad Spend÷Total Sales). Table helpers: `monthBack`, `dailyReportColumns`, `DAILY_METRICS`. Wide table scrolls horizontally with a sticky metric column.
- Total Sales and Units populate from the existing sales source now. Ad Sales/Spend/Clicks (and the derived ROI/ACoS/TACoS) show "—" because no DataDoe advertising source is wired yet. The frontend reads ad fields optimistically via `pickNum` + candidate key lists (`AD_SALES_KEYS`, `AD_SPEND_KEYS`, `CLICKS_KEYS`), so the table auto-fills once the export includes real ad columns.
- Added a temporary discovery route to `api/datadoe.js`: `?action=fields` (optional `&sourceId=`). It probes candidate DataDoe source/column endpoints and returns their JSON so we can identify the advertising source id + column names. Remove this route after the ad source is confirmed. It exposes source metadata (not the API key) on the live URL while present.
- IMPORTANT — source granularity finding: `401ffcd7e5` ("Sales & Traffic by ASIN & Date") is **per-ASIN**, ~700 rows/account/day (mostly zero-sales rows), and has no currency/name columns. It has data for AAKRITI only from ~2026-04-27 onward. Summing ALL rows per day gives correct totals (full June = ₹623,252 / 456 units, matching Seller Central expectations); a naive fetch with a low row limit truncates recent dates to ₹0. It cannot be used for the multi-account dashboard (would be millions of rows), so it is used ONLY for the single-account Daily Reporting view.
- Architecture split in `api/datadoe.js`:
  - `action=brand-sales` (main dashboard): **Order Line Items** data, grouped server-side by date/account/currency/child ASIN. The server maps ASINs to `product_brand` via the Product Catalog source and folds the response to date/brand totals. It uses `item_price_value`, DataDoe's documented order value field, so Select All Brands reflects Seller Central Order Report sales including pending orders. A cache version is included in `dashboardParams`, preventing pre-change profit totals from being reused after deployment. The legacy `action=sales` fast daily profit rollup remains available for compatibility but is no longer used by the dashboard UI.
  - `action=daily` (Daily Reporting): DataDoe now aggregates sales and ads server-side by `(seller_or_vendor_id, date)`, then the API merges the two compact results. This avoids raw ASIN/ad-row truncation and returns one row per day to the frontend.
- Advertising source `08cdc77d3d` was configured with columns `ad_sales`, `ad_spend`, `ad_clicks`, but it returned `404 Source not found` on 2026-07-24. Do not rely on its Daily Reporting metrics until it is replaced or the route is made sales-only.
- Export helpers generalized: `createExport`/`fetchExportRows(apiKey, sourceId, columns, ids, from, to, limit)` work for any source with a per-call limit.
- Rate limiting: DataDoe caps at 2 requests/sec per organization; the all-accounts dashboard load (chunked exports) plus any concurrent usage was surfacing HTTP 429 in the UI. Added `ddFetch` in `api/datadoe.js` — a wrapper that spaces DataDoe requests ~550ms apart (`MIN_REQUEST_INTERVAL_MS`) and auto-retries on 429 using `retryAfterSeconds`/`Retry-After` (up to 6 times). All accounts/export/poll/download calls route through it. The account-scope tabs are NOT the cause of the 429.

## FBA Shipment Plan report (added 2026-07-26)

New sidebar report directly below Daily Reporting. Single selected account, cache-first, manual-refresh-only, all planning math computed in the browser. Backend action `fba-plan` in `sales-dashboard-live/api/datadoe.js`; frontend view + helpers in `sales-dashboard-live/src/App.jsx` (`computePlanRow`, `comparePlanRows`, `planSearchMatch`, `PlanTh`).

### DataDoe sources & field mappings (verified against https://api.datadoe.com/api/v1/spec/data-scheme — public, unauthenticated; there is NO REST "list sources" endpoint, use the spec URL)
- Unit sales per ASIN: `401ffcd7e5` Sales & Traffic by ASIN & Date (`amazon_sales_and_traffic_with_cogs`), column `total_units`, grouped server-side by `child_asin` per month window. Same source Daily Reporting already reconciled to Seller Central.
- Live FBA inventory: `44fc5ba0ce81a7807601f6d7a9b8b7aaec64be4c7e046ea30dc6864d1a4aa823` FBA Inventory Health (`amazon_fba_inventory_health`). Per-SKU fields used: `available`, `reserved_fc_transfer`, `reserved_fc_processing`, `inbound_shipped`, `inbound_received`, `inbound_working`, `sku`, `child_asin`, `product_name`, `date`. Snapshot is per-SKU per-day; the server keeps only the latest snapshot date (fetch ordered by date DESC over a 10-day lookback, then filter to max date) and folds SKUs to ASIN by summing.
- AWD available (US accounts only): `ba689c05d7f7cee1a1690990c28995680a0654b7ed258230f4173d61bbcd1ab3` Listings (`amazon_listings_with_cogs`), column `awd_available_distributable_quantity`. Listings has NO date column, so its export sends no from/to and orders by `child_asin` (createExport now omits from/to when falsy).
- Brand + product name: `68d2de23...` Product Catalog by ASIN (`product_brand`, `product_name`), fetched over the 3-month+MTD window.

### Field-mapping decisions (per spec + confirmed on real rows)
- FBA Available = `available`.
- Reserved = `reserved_fc_transfer` + `reserved_fc_processing` ONLY. Customer-order reserve (`reserved_customer_order`) is intentionally excluded and never fetched. NOTE: `total_reserved_quantity` is unreliable in raw data (observed total=3 while fc_transfer=14, fc_processing=1) — do NOT use it.
- In Transit to FBA = `inbound_shipped` + `inbound_received`. `inbound_working` (still being prepared, not yet shipped) is intentionally excluded per the "already shipped/inbound/receiving" definition.
- AWD only applies to US-marketplace accounts (isUS derived from the authoritative DataDoe accounts-list country, not client input). Non-US accounts get AWD null/hidden; it never enters coverage or the recommendation.

### Calculations (browser, `computePlanRow`)
- 3 Month Avg = (m1+m2+m3)/3 over the 3 completed calendar months.
- MTD Projected Monthly Units = (MTD units / elapsed days) * days in current month. elapsedDays = day-of-month of the latest COMPLETED sales date (not the raw calendar day), so a reporting lag does not understate velocity; 0 if no current-month sales.
- Planning Avg = max(3-month avg, MTD projected).
- Daily Planning Rate = Planning Avg / days in current month.
- Target Units = Daily Rate * Target Coverage Days (numeric input at top, default 30, any positive number; recomputes locally, no fetch).
- Total FBA Inv. = FBA Available + Reserved + In Transit (+ AWD for US).
- Recommended Shipment = max(0, ceil(Target Units - FBA - Reserved - In Transit [- AWD if US])).
- Stock Remark = Restock if Recommended > 0 else OK.

### Behaviors / assumptions
- **Global report scope (added 2026-07-26):** `selectedAccountId` and `selectedBrand` in `src/App.jsx` are the only account/brand selectors for Dashboard, Daily Reporting, FBA Shipment Plan, and all future reports. The selectors live in the header on every view; do not add page-level account or brand selectors. New reports must use this shared scope, read cached data for it on navigation/scope change, and make DataDoe calls only on explicit refresh.
- Header brand choices are strictly account-scoped. The app reads only cache keys for the selected account and tracks the account that owns in-memory catalog brands, preventing a prior account's brands from appearing while a newly selected account is loading.
- Daily Reporting accepts the shared brand in `action=daily`. For `Select All Brands`, it retains compact account/day sales and advertising data. For a named brand, the server groups Sales & Traffic data at ASIN/day grain, joins Product Catalog `product_brand`, then returns only that brand's sales and units. It fetches each calendar month separately (limit 50,000 rows/month) to avoid silent ASIN/day truncation. Advertising metrics intentionally render unavailable for named brands because the current advertising export is account-level and cannot be attributed accurately to a product brand.
- Production validation on 2026-07-26 for Indya Store IN: `brand=Caruso Italy` returned `brandFiltered:true`, 89 daily rows (2026-04-27 through 2026-07-24), 27,050 units, and no advertising fields. The matching `brand=ALL` request returned `brandFiltered:false`, 91 daily rows, and advertising fields on all rows. This confirms no account-level advertising values are mixed into a selected brand.
- One row per ASIN. SKU->ASIN folding sums inventory across SKUs. Representative SKU = first non-empty SKU in ascending `localeCompare` order (stable across refreshes), gathered from FBA Inventory Health + Listings.
- Rows are limited to ASINs with real activity: any unit sales in the window OR any live FBA/AWD stock. This drops the large zero-sales/zero-stock catalog tail that Sales & Traffic emits daily (e.g. AAKRITI 2226 -> 1225 rows; Haven&Hue 92 -> 79).
- Live inventory freshness (snapshot date) is shown separately from sales-report freshness (latest completed sales date). When the whole FBA inventory snapshot is unavailable, coverage/recommendation render "—" with a banner; sales velocity still displays. No values are fabricated.
- Cache key (`planParams`) = {action:"fba-plan", reportVersion:"fba-plan-v1", ids, to}. Target Coverage Days, search, and sort are NOT in the key — local recompute only. Refresh is single-account (server rejects != 1 id with HTTP 400).
- `sales-dashboard-live/vercel.json` added with `maxDuration: 60` for `api/datadoe.js` (the plan makes ~7-8 sequential, rate-limited exports; observed 25-33s per refresh).
- On 2026-07-26, the plan table was updated to round all visible unit values to whole units. The former displayed `Plan Avg` column was replaced with dynamic `Target Units (Nd)`: `Planning Avg / days in current month * Target Coverage Days`. This makes the entered days visibly change the required stock, while 3-month average and MTD projection remain demand inputs. Recommended Shipment still uses the exact calculation and rounds up with `ceil`.
- The plan has a `Download Excel` action that exports the currently visible (searched and sorted) rows as a UTF-8 BOM CSV, which opens directly in Excel. It includes all displayed planning/inventory columns and the dynamic target-days column; CSV cells are protected from spreadsheet-formula injection. Do not add the npm `xlsx` package for this: its audit reported two unpatched high-severity advisories, so the dependency was removed.
- `Total FBA Inv.` means inventory already counted toward meeting demand: FBA Available + Reserved FC Transfer/Processing + In Transit; US accounts also add AWD Available. It is a quantity of units, not a number of days.
- On 2026-07-26, the combined inventory label was renamed from `Coverage Units` to `Total FBA Inv.`. A new sortable `FBA Days (MTD DRR)` column was added to the table and Excel-compatible export. It is `FBA Available / (MTD Units / completed sales days)` and displays whole days; it intentionally excludes reserved, inbound, and AWD inventory because those units are not physically available in FBA. When MTD DRR is zero or unavailable, it displays `—`. The totals row uses total FBA Available divided by the summed MTD DRR, rather than summing individual ASIN cover days.
- Latest production deployment for the rounded units, dynamic Target Units, and Excel-compatible export: `https://upriver-dashboard-5dema7vbr-laxmikant1604s-projects.vercel.app` (2026-07-26). It is aliased to `https://upriverdashboard.vercel.app`; the production bundle was checked for all three new UI strings.
- Latest production deployment for `Total FBA Inv.` and `FBA Days (MTD DRR)`: `https://upriver-dashboard-q4j2n5cg1-laxmikant1604s-projects.vercel.app` (2026-07-26), aliased to `https://upriverdashboard.vercel.app`.
- Latest production deployment for the global header account/brand scope and Daily brand filter: `https://upriver-dashboard-btlg1nskn-laxmikant1604s-projects.vercel.app` (2026-07-26), aliased to `https://upriverdashboard.vercel.app`.

### Verification (Haven&Hue US and AAKRITI IN)
- Sales reconciliation EXACT: plan per-ASIN monthly sums equal `action=daily` (same source 401ffcd7e5, grouped by date). Haven&Hue: Apr 92 / May 646 / Jun 877 / Jul-MTD(<=07-22) 462 identical both ways. AAKRITI June = 467 units, matching the previously documented Seller Central reconciliation.
- Inventory per-ASIN reconciliation MATCH vs raw 2026-07-23 FBA Inventory Health snapshot: B09F3RBP4K avail96/fct2/fcp1, B09F3SVQW3 avail0/fct(null->0)/fcp19, B0BVMQ49TC avail1/fct0/fcp3 — all exact, including null->0 coalescing.
- AWD: Listings export with no date range works; Haven&Hue returned 24 ASINs with AWD>0. Non-US (AAKRITI) returns awdAvailable=null on every row and no AWD column.
- UI (Playwright, desktop 1440 + mobile 390): sticky Product/ASIN column holds when scrolled; horizontal scroll is inside the table only. Fixed a bug where the min-width:1080 table forced the whole page to overflow to 1240px on mobile — root cause was `.container { margin:0 auto }` disabling flex stretch; fixed by adding `width:100%` (and `min-width:0`). Search 79->3 on "hella"; restock rows highlighted; math confirmed (B000CRZXPI 3M avg 66.3, MTD proj 100.0, plan avg 100.0). No console errors. Independent code review found no issues.

### Known limitations / risks
- Refresh latency 25-35s (many sequential rate-limited exports); could approach the 60s function limit on a slow DataDoe day — the UI then surfaces the error and the user retries.
- Large catalogs (e.g. AAKRITI ~1225 rows) make a sizable localStorage entry; `writeApiCache` already swallows quota errors so the app stays usable.
- Sales source (401ffcd7e5) can lag a few days; MTD projection is anchored to the latest completed sales date, which is shown in the UI.
- Independent Codex review on 2026-07-26 verified the deployed Haven&Hue US plan end to end: one-account request completed in 27.2 seconds, returned 79 ASIN rows, sales through 2026-07-24, FBA snapshot dated 2026-07-26, and AWD inventory for 24 ASINs. The current upstream sales values had settled to Apr 92, May 646, Jun 876, and Jul MTD 484 units; values can change as DataDoe finishes synchronization.
- **Review follow-up — accuracy at month rollover:** `planMonthWindows(to)` chooses the prior three *calendar* months before checking whether DataDoe has complete sales for them. On the first days of a new month, a lagging source can make the just-finished month incomplete while it is still counted as a completed month, understating the 3-month average and shipment recommendation. Before relying on the plan across a month boundary, change the backend to select the last three fully populated source months (or clearly mark/block an incomplete month).
- **Review follow-up — duplicate manual refreshes:** the header refresh button is not disabled while a plan is loading, and `fetchPlan` has no in-flight guard. Repeated clicks can launch concurrent 25-35 second exports, spending extra DataDoe quota and bypassing the intended sequential rate protection across Vercel invocations. Add a shared client-side in-flight guard and disable the refresh button for every report while its request is active.
- **Review follow-up — stale-cache UX:** the plan cache key includes `to=TODAY`. A report fetched yesterday is not reused after midnight; no automatic request is sent, but the user sees a cache-miss prompt instead of the last fetched plan. If the product requirement is to display the previously fetched data until manual refresh, add a latest-cache lookup per report version/account and label it with its as-of date.
- **Review follow-up — partial-source failure:** the UI's inventory-unavailable banner only handles a successful export with no inventory rows. A failed FBA Inventory Health or US Listings export currently aborts the whole `fba-plan` request, so sales velocity cannot be shown. Decide whether the endpoint should return a sales-only, explicitly unavailable inventory state for those upstream failures.

## In progress

- **Amazon Ads data-scheme fetch-window audit (2026-07-29):** verified the public DataDoe specification `https://api.datadoe.com/api/v1/spec/data-scheme` and documented all 26 `AMAZON_ADS` tables in `sales-dashboard-live/supabase/DATADOE_AMAZON_ADS_FETCH_WINDOWS.md`. Nine dated performance reports declare fixed initial/recurring windows: ASIN performance, Search Term Performance, and Purchased Products = **60 initial / 21 daily / 49 monthly**; Campaign performance, Keyword Targeting, Sponsored Brands Ad Performance, and **Ad Group Performance** = **56 initial / 21 daily / 49 monthly**; Placement = **56 initial / 28 daily / 56 monthly**; Ads Brand Metrics = **95 initial / 95 weekly**. Sixteen raw/configuration/AMS tables are `CONTINUOUS` with no stated numerical historical backfill; Sellers & Vendors Context has no date/fetch period. Crucial interpretation: these are DataDoe source-fetch/re-correction windows, **not an explicit deletion or permanent query-retention policy**. A new Ad Group connection initially gets 56 days; after that, history can accumulate and the recurring window should be UPSERTed so late attribution corrects recent data. **Month-wise and day-wise reports are possible for every future month** when the dated rows are synced into Supabase now: retain each daily date row, re-upsert the rolling correction window, and aggregate any selected calendar month locally/server-side. Months before the initial DataDoe backfill cannot be reconstructed unless DataDoe already retained them or they are imported from another audited source. The planned Supabase store preserves all successfully synced history from the first sync onward.
  - **Required sync semantics clarified:** initial seed imports the source's available days; every daily job re-fetches the whole documented recent window (normally 21 days, Placement 28) and UPSERTs by the report's natural daily grain, so it replaces late-attribution values rather than duplicating them. A monthly correction job re-fetches 49/56 days (Brand Metrics 95 days weekly). Thus “after 21 days” is not a waiting period: a daily row is repeatedly refreshed while inside the rolling window, then retained as the final known history in Supabase. The UI reads Supabase only; manual refresh is selected-account-scoped and uses a database lock to avoid duplicate DataDoe exports. Full implementation specification is in `sales-dashboard-live/supabase/DATADOE_AMAZON_ADS_FETCH_WINDOWS.md`; this sync is still pending application code.
  - **Ad-product coverage verified:** `Keyword Targeting Performance` (`amazon_ads_targeting_by_campaign_by_date`) is **SP + SB + SD**: its DataDoe dependencies are the SP, legacy SB, and SD targeting raw reports. `Search Term Performance (Ads)` (`amazon_ads_search_terms_by_campaign_by_date`) is **SP + SB only**, not SD: its documented `ad_campaign_type` values are `SPONSORED_BRANDS or SPONSORED_PRODUCTS` and its dependencies include only SB/SP search-term reports. Any future PPC UI must retain `ad_campaign_type` and not label Search Term results as full three-product coverage.
  - **Core Ads date-grain clarified:** Keyword Targeting Performance, Ad Performance by ASIN & Date, and Ad Performance by Campaign & Date all include daily `date` data. Their grains differ: targeting/keyword + campaign/date, child ASIN/date, and campaign/date respectively. Month-wise reports are created by summing the appropriate daily source rows; do not compare raw row counts or join the tables without respecting their different attribution grains. Campaign/date is the compact account/campaign total source, ASIN/date is product attribution, and targeting/date supports keyword/target analysis with SP/SB/SD split by `ad_campaign_type`.
- **Repository privacy hardening completed and deployment-proven (2026-07-28):** user changed `LaxmiKant1604/Upriver-Dashboard` to private. Post-change verification passed: authenticated `git ls-remote origin HEAD` returned commit `7a19e109...`, confirming Codex can still fetch/push to the private remote; Vercel project inspection still reports the correct linked project `upriver-dashboard`, Root Directory `sales-dashboard-live`, and Node 24.x. The proof commit `d321045` pushed successfully to the private remote and triggered a new production deployment, `https://upriver-dashboard-f1m6cykfg-laxmikant1604s-projects.vercel.app`, which completed `Ready` in 12 seconds. Supabase is independent of repository visibility and remains connected through Vercel. Public forks, if any, remain public/detached; privacy does not retract code already copied. Sources checked 2026-07-28: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility and https://vercel.com/docs/git.
- **Supabase provisioned and schema applied (2026-07-28):** after the team accepted Vercel Marketplace terms, Vercel provisioned the Free-plan `upriver-shared-data` Supabase resource in Mumbai (`bom1`) and connected it to `upriver-dashboard` Production, Preview, and Development. It injected `POSTGRES_*`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and `VITE_SUPABASE_*` values; the root `.env.local` was pulled locally and remains gitignored. The versioned migration `sales-dashboard-live/supabase/migrations/20260728_shared_dashboard.sql` is now applied through the reusable `npm run db:migrate` runner. Verified live tables: `account_permissions`, `ad_daily_metrics`, `app_schema_migrations`, `cogs_overrides`, `dashboard_events`, `report_refresh_locks`, `report_snapshots`, and `user_profiles`. A server-only REST read through `api/supabase.js` passed using the Vercel-provided secret; no credentials were printed or committed. The migration uses a private `dashboard-snapshots` bucket for large payloads and publishes only compact `dashboard_events` rows to Realtime. The local migration runner sets the marketplace pooler's `sslmode=no-verify` compatibility mode because the Windows Node trust store rejected its chain; it remains encrypted and is used only for direct migrations, while deployed app access uses HTTPS Supabase REST. **Current status:** the database foundation is live, but no report path, COGS edit, login, role UI, or Realtime subscription is wired yet, so dashboard behavior and browser-local cache are unchanged. Next implementation: migrate a compact selected-account report to `report_snapshots` with an explicit refresh lock, then migrate COGS and remaining reports incrementally.
  - **Owner login/access decision:** this Supabase organization was created through Vercel Marketplace, so Vercel has a one-to-one organization relationship and synchronizes Vercel team roles to Supabase. Use the existing Vercel owner account as the primary administrator; open Supabase Studio through the Vercel Integration/Storage dashboard. Do **not** create a separate Supabase email/password owner for this marketplace-managed project. For direct `supabase.com` dashboard access outside Vercel, use **GitHub OAuth with the same primary email address as the Vercel account**; Supabase documents that email/password login is disabled for accounts created via the Vercel Marketplace. Enable MFA on the Vercel identity and retain a secure backup TOTP factor. Sources checked 2026-07-28: https://supabase.com/docs/guides/integrations/vercel-marketplace and https://supabase.com/docs/guides/troubleshooting/email-password-login-disabled-supabase-vercel-marketplace-a7dd36.
  - **Administrator access confirmed (2026-07-28):** the project administrator successfully signed in to the Supabase dashboard using GitHub. This is management access only; it is separate from the future Upriver dashboard user-login feature. No Supabase Auth provider or application user should be manually created yet because the React login screens, callback URLs, role-assignment workflow, and server authorization checks have not been implemented.
  - **Supabase console verification (2026-07-28):** the administrator confirmed the expected `upriver-shared-data` project in Supabase Studio. The console shows the organization is Vercel Marketplace-managed, the database region as AWS `ap-south-1` (the Mumbai/India selection requested as `bom1` through Vercel), the Free/Nano plan, 26 MB of 500 MB database capacity in use, and zero egress/active users/file storage at this initial setup stage. No additional Supabase-console provisioning action is needed now; do not create another project or click `New project`.
- **Shared advertising-history store (confirmed 2026-07-28, implementation pending Supabase):** DataDoe's verified `Ad Performance by Campaign & Date` source is `08cdc77d3dc24a7651553e2e926f598188c66172f64cd6512265900af6073a6c` (`amazon_ads_performance_by_campaign_by_date`). Its initial connection backfill is 56 days; after that DataDoe re-fetches the most recent 21 days daily and 49 days monthly, so late attribution changes can revise recent figures. A Supabase `ad_daily_metrics` history table is the correct solution: sync the available date range through one controlled server refresh/cron, then upsert by account + date + campaign + campaign type (not append) so corrected values replace the prior snapshot. Dashboard reports will read Supabase first and only the controlled sync will call DataDoe, preventing every user/browser from spending API tokens. This preserves history **from the first successful sync onward**; it cannot recreate dates older than the initial 56-day DataDoe backfill. The current Daily Reporting source constant uses the abbreviated `08cdc77d3d` prefix; verify/replace it with the full source ID as part of the Supabase ads-sync implementation, then reconcile actual ad sales/spend/clicks before relying on it.
- **Keyword Rank & Share Tracker (completed and deployed 2026-07-28):** added a `Keyword Rank` sidebar report backed by the DataDoe skill https://github.com/Deltologic/datadoe-ai-skills/tree/DOE-2733-skill-metadata-categories/skills/keyword-rank-sqp-tracker. It uses only the shared header Account/Brand scope and the existing cache-first/manual-refresh pattern: navigation, account/brand/ASIN/search/signal filters, and sorting are local; only Refresh calls `action=keyword-rank`. Backend is single-account enforced and uses Weekly SQP source `81aa5b4cc248bb70de405b9ff9d51290b9232f84570d76ba2a1289b67b6595fb` (`amazon_child_product_organic_search_ranks_per_week`) over an 84-day window. It fetches Monthly SQP source `df4160ff8e1add239172a69ebd6c8abfec7116ee4a17720983757b1b55599830` when fewer than four weekly periods exist, and shows an explicit baseline rather than fabricating a trend when fewer than two comparable periods remain. The UI calculates impression/click/purchase shares from the query totals, tracks only converting money keywords, compares recent periods to prior periods, and flags Lost, Slipping, Rising, Emerging, Stable, or Baseline with a concrete action. Exports that hit the 50,000-row cap are rejected rather than silently truncated. Both SQP tables are non-default in DataDoe; an organisation-disabled source returns HTTP 424 with DataDoe Settings > Data tables enablement instructions. Commit `020a300 Add keyword rank SQP tracker`; production deployment https://upriver-dashboard-gs29ejhxw-laxmikant1604s-projects.vercel.app is aliased to https://upriverdashboard.vercel.app. Verification: `node --check api/datadoe.js` and `npm run build` passed. A live one-account AAKRITI request on 2026-07-28 returned weekly mode with 8 complete SQP periods (2026-05-24 through 2026-07-12), proving the weekly source and source fields work on this organisation. A two-account request returned HTTP 400 `Keyword Rank requires exactly one selected account.` before DataDoe access. Browser-level visual interaction still needs a manual production refresh because the local Playwright browser runtime is unavailable in this workspace.
- **Shared online cache and COGS persistence (requested 2026-07-27):** the current cache and SKU COGS overrides live in each browser (`localStorage` / IndexedDB), so one user's manual refresh or COGS edit is not visible to other users. The requested next architecture is a durable server-side store: one user explicitly refreshes a selected report/account scope, the server obtains DataDoe data once, saves the successful snapshot, and all users then read that same snapshot without spending another DataDoe request. COGS overrides must move to the same shared store and be keyed by account, currency, SKU, and ASIN. A per-report/scope refresh lock is also required so simultaneous clicks cannot start duplicate DataDoe exports. **Decision:** use a Vercel Marketplace PostgreSQL integration (recommended: Neon) rather than Vercel Blob because report/COGS changes need immediate, concurrent, queryable updates; no database credentials are connected to this project yet. Do not claim this is active until `DATABASE_URL` is provisioned and the server/client paths are implemented and deployed.
  - **Cost decision:** Neon currently offers a no-time-limit $0 Free plan with no credit card required, 0.5 GB storage per project, and 100 CU-hours of compute per project/month. It is appropriate for the initial shared cache if the application retains only the latest successful snapshot for each report/scope and purges superseded snapshots. Monitor usage because the reconciliation response can be about 23 MB per account/scope; move to paid usage-based Neon only if the retained data or traffic grows beyond the free allowance. Source checked 2026-07-27: https://neon.com/pricing.
  - **Alternatives reviewed:** Supabase is also managed Postgres (starts at $0) and adds built-in authentication/realtime, making it a good choice if user accounts/permissions are added soon. Upstash Redis is excellent for short-lived cache entries and distributed refresh locks, but it is not the right sole durable store for COGS history and larger report snapshots. Firebase Firestore has a free quota and realtime updates, but would require a different NoSQL/auth client architecture from the existing Vercel serverless app. Vercel Blob is file storage, not suitable as the primary mutable collaborative data store. Keep Neon Postgres as the recommended single-service starting point; revisit Supabase only if dashboard login/roles/realtime subscriptions become a near-term requirement. Sources checked 2026-07-27: https://vercel.com/docs/marketplace-storage and https://vercel.com/marketplace/supabase.
  - **Supabase selected (2026-07-27):** user confirmed that login, roles, and live update notifications are near-term requirements, so Supabase replaces Neon as the recommended shared platform. It will provide Postgres for report snapshots/COGS overrides, Supabase Auth for user login, Row Level Security for roles, and Realtime for cache/COGS change notifications. Vercel CLI verification found no Supabase resource currently connected; install the Supabase Marketplace integration into `upriver-dashboard` before implementation. Do not expose `SUPABASE_SECRET_KEY` to the browser; only the publishable key and URL may be used by the frontend, while all DataDoe calls and privileged writes remain server-side.
  - **Supabase Free-plan verification (2026-07-27):** the official plan is $0/month with 500 MB database storage, 50,000 monthly active users, 5 GB egress, and Realtime (2 million messages/month, 200 concurrent peak connections). It is adequate to start the shared-cache/auth feature, but a free project pauses after one week of inactivity and has no automatic backups; its first request after a long idle period can be delayed. Use a compact notification payload (cache key/timestamp, never a whole report) because Free Realtime messages max out at 256 KB. Monitor retained report snapshots and upgrade to Pro only when storage, production-reliability, or backup requirements demand it. Source checked 2026-07-27: https://supabase.com/pricing.
  - **Claude storage decision (2026-07-28):** do not use Claude, Claude Code, or an AI-assistant workspace as the Upriver application's business-data store. They can retain code and project documentation such as this file, but they are not the dashboard's shared transactional database and do not provide the required application-owned persistence, row-level authorization, realtime subscriptions, refresh locking, or scheduled report upserts. Store shared report snapshots, advertising history, COGS overrides, users, and roles in Supabase; keep DataDoe credentials and privileged writes server-side. Claude/Codex remain development assistants and handoff-document writers only.
  - **Google storage clarification (2026-07-28):** "Claude" is Anthropic's product, not a Google storage service. Google Drive is suitable only for optional report exports/backups (for example, CSV/XLSX snapshots); it is not suitable as the live shared dashboard database because concurrent updates, query performance, application authorization, and realtime synchronization would be fragile. If the team prefers Google infrastructure, Google Cloud Firestore plus Firebase Authentication can satisfy the shared-cache, login/role, and live-update requirements, while Cloud SQL/Postgres is another valid Google Cloud alternative. Supabase remains the selected implementation because it provides the required Postgres, Auth, RLS, and Realtime features together with less application infrastructure. Do not use Google Drive or Google Sheets as the primary live store.
  - **Expected live-data flow after Supabase implementation (2026-07-28):** when an authorized user explicitly refreshes a report for one account/scope, the server fetches DataDoe once, validates the result, and saves/upserts the snapshot in Supabase. Every dashboard session then reads that shared saved snapshot rather than making its own DataDoe call. Supabase Realtime broadcasts only a small "snapshot updated" event; open dashboards receive it and reload the saved data, so users see the refreshed values without manually refreshing the browser. This is not active yet: until Supabase is connected and the current local cache is migrated, data remains per-browser in IndexedDB/localStorage.
- **Dashboard order-report sales reconciliation:** the attached Seller Central Order Report `C:\Users\laxmi\Downloads\793915020661.txt` definitively totals JustHuman IN on 2026-07-26 at `INR 84,673` item price across 66 sale units (57 shipped lines = `INR 78,924`; 9 pending lines = `INR 5,749`; 5 cancelled lines = zero; item tax = zero). The live DataDoe Order Line Items source still returns `INR 79,510` across those same 66 units: 60 priced units under JustHuman plus 6 zero-price/unassigned units, a precise `INR 5,163` understatement. Sales & Traffic by ASIN & Date has no row at all for this date, so it cannot be used as a fallback. The dashboard does not fabricate the missing amount; it retains and displays `unpriced_units` as a data-completeness warning. This is a **high-severity upstream DataDoe synchronization defect** for recent order values: request a DataDoe/Amazon order-data resync before treating this date as final. A permanent code fix requires a DataDoe source that contains the missing order values or an explicitly approved Seller Central report-import workflow; neither is available in the current server-side credentials.
- **Sales-source comparison (2026-07-27):** checked every currently connected sales-capable DataDoe report for JustHuman IN / 2026-07-26 against the `INR 84,673` Seller Central Order Report benchmark. Order Line Items (`89b275...`) is closest but incomplete at `INR 79,510` / 66 units / 6 zero-price units. Profit by Date (`b24cd69c06`) and Profit by SKU & Date (`57a0...`) both return `INR 73,761` / 51 units because they are settlement/profit-oriented and omit pending or not-yet-settled activity. Sales & Traffic by ASIN & Date (`401ffcd7e5`) returns no rows for this date because of its multi-day freshness lag. Settlements & P&L Components (`732dac...`) is payout/posting-date data, not an order-day sales total. **Decision:** do not swap the dashboard to any of these reports for recent Seller Central Order Report sales; use Order Line Items with its completeness warning until DataDoe resolves the missing values, or add an audited Seller Central report-import override.
- **Export polling reliability:** a one-day JustHuman Sales & Traffic export timed out because `pollExport` stopped after about 18 seconds (`12 × 1.5s`), below DataDoe's normal completion window. `pollExport` now uses nine five-second attempts (about 40 seconds after the first check), still within Vercel's 60-second function limit. Retesting completed successfully, but Sales & Traffic returned no 2026-07-26 row for JustHuman, so its multi-day freshness lag makes it unsuitable as a fallback for the latest Order Line Items date.
- **Content Change Alerts:** implementation is deployed and the route is verified, but live events are blocked until this DataDoe table is enabled for the organization. In DataDoe, open **Settings > Data tables** and enable **Branded Item Content Change Notifications**, then use the dashboard's Refresh button. It is a cache-first selected-account report that extracts ASINs from notification payloads, resolves them through the Product Catalog where possible, and applies the shared brand filter only to attributable events. This source has no sales, inventory, or profit metrics and must not be used for those reports.
- **SKU P&L Analyzer:** deployed. It uses the reviewed Profit by SKU & Date source over six full calendar months, keeps currencies separate, computes all ratios locally from summed amounts, and shares the global Account/Brand scope. It remains cache-first; only the header Refresh button fetches DataDoe data.
  - **Verification completed 2026-07-27 (Claude, `action=sku-pl` against the preview and production `/api/datadoe`):** Haven&Hue US returned exactly `2026-01..2026-06`, one currency `["USD"]`, 134 SKU rows; each per-month bucket contains only the seven summed fields (`sales,profit,cost,adSpend,fees,cogs,units`) and **no ratio fields** — margin/ACoS/blended are recomputed in the browser. Guards verified: a 5-month range, a mid-month start, and a two-account request each return HTTP 400 before any DataDoe access. AAKRITI IN returned `["INR"]`, 1,769 rows, no truncation (well under the 50k monthly cap). Currency separation confirmed (USD vs INR never combined). Cross-source sanity check: AAKRITI June Profit-by-SKU sales `₹632,639` vs the documented Sales & Traffic June sales `₹633,481` = 0.13% apart (expected profit-vs-sales-source gap; not fabricated). Profit identities hold exactly on 500 real buckets: `profit = total_sales − total_cost` and `total_cost = total_fees + ad_spend + cogs_total` (0 violations). Missing-COGS handled correctly: AAKRITI has COGS on 0 of 1,769 SKUs, so every row is flagged **Check COGS** rather than shown as a real high margin. UI (Playwright, built bundle): month switch, currency selector (shown only when >1 currency), search, status filter, sort, and header brand filter (e.g. "Caruso Italy" → only Caruso rows) are all local — **0 `/api/datadoe` calls** across nav, account change, month, search, filter, sort, and brand change (cache-first confirmed); refresh has an in-flight guard and is disabled while loading. Mobile 390px: table scrolls inside its container with a sticky Product/SKU column and **no page-level horizontal overflow** (`document.body.scrollWidth === innerWidth`); no console errors. Payload ~817 KB for AAKRITI, so the report is cached in IndexedDB (`upriver-report-cache`) with a localStorage fallback, reportVersion `sku-pl-v1`.
  - **Codex review fix (2026-07-27):** a standalone SKU P&L refresh previously did not populate the shared header Brand selector when the selected account had no prior dashboard catalog cache. The API now returns distinct P&L `catalogBrands` plus its `accountId`, and the frontend feeds them into the existing account-scoped header state. This retains local filtering and makes the shared scope usable from this report alone; a fuller dashboard catalog cache is still merged when present.
  - **Decision — ACoS column:** the mandated aggregation set excludes `ad_sales`, so classic ACoS (ad spend ÷ ad sales) is not computable. The table/CSV column is therefore labelled **"Ad/Sales %" = ad spend ÷ total sales** (computed from the allowed sums) and the footer states this explicitly, rather than mislabelling a total-sales ratio as ACoS. If a true ACoS is required later, add `ad_sales` to `SKU_PL_AGGREGATIONS`.
  - **Latency risk:** a six-month refresh runs six sequential, rate-limited monthly exports and took ~20–46s in testing — under the 60s `maxDuration`, but a very large catalog on a slow DataDoe day could approach it. The `datadoe-api-starter` `dateInterval:"MONTH"` option could collapse the six exports into one and cut latency; it is unverified in this repo and left as a follow-up (monthly batches were kept because they are explicitly endorsed and proven).
  - **Concurrency note:** this feature was committed by a concurrent process as `6391bd3 Add SKU P&L and content alerts` (bundled with the unrelated Content Change Alerts feature) and deployed to production as `7415186`/`aidb49f1v` before this verification ran — i.e. it is already live on `https://upriverdashboard.vercel.app`, not deployment-pending.
- **Amazon Reconciliation Dashboard:** completed and deployed on 2026-07-26. The new sidebar report uses the shared Account/Brand header scope, reconciles six *full* calendar months of Order Line Items with Settlements & P&L Components, and performs month switching, charts, Order Explorer filtering/sorting/pagination, copy-order-ID, and Excel-compatible CSV export locally after an explicit refresh. It makes settlement posting dates and cross-month timing visible rather than calling normal Amazon timing differences errors. Confirmed settlement source: `732dac689a6545697c2f2e36c61b2c9e93187053bcce2999914183c6f490df27`; financial fields: `item_price`, `item_tax`, `referral_fee`, `fba_per_unit_fulfillment_fee`, `refunded_amount`, and `total` (not the generic skill's `sum_*` aliases). Named-brand reconciliation intentionally keeps only single-brand orders because settlement events are order-level and cannot be allocated accurately across items in a mixed-brand order.
- **Delivery protocol:** for future Claude/Codex changes, the implementing agent must update this memory with completed work, in-progress/pending work, decisions, technical learnings, and verification. Codex must then perform a senior-engineer review, resolve material findings, verify the deployed behavior, and record a concise completion/deployment summary before declaring the task finished.
- FBA Shipment Plan review follow-up is open: address month-rollover completeness and duplicate-refresh protection before treating shipment recommendations as production-accurate in all periods. The main dashboard now uses DataDoe Order Line Items (`89b275...`) rather than Profit by SKU & Date for its sales total.
- Temporary discovery routes `?action=fields` and `?action=sample` still exist in `api/datadoe.js`; remove them now that sources/columns are confirmed.

## Pending tasks and known follow-ups

- Verify sales numbers on the live dashboard match Seller Central expectations.
- Recheck very recent Order Line Items values after DataDoe completes its upstream synchronization. The 2026-07-23 Indya Store export was `INR 1,081` short of the downloaded Seller Central report because three units had zero `item_price_value` in DataDoe. The dashboard must not fabricate the missing revenue; click manual refresh after DataDoe has populated those order values.
- Obtain a DataDoe/Amazon order-data resync for JustHuman IN on 2026-07-26: the supplied report proves the `INR 5,163` shortfall across six zero-price source units. Do not substitute a hard-coded correction. If DataDoe cannot provide a complete order source, decide whether to add a user-driven Seller Central Order Report import that is stored as an auditable account/date override.
- Revalidate Daily Reporting advertising metric accuracy after any DataDoe source change. The source `08cdc77d3d` returned `404 Source not found` on 2026-07-24, but a deployed `action=daily` request for AAKRITI returned HTTP 200 with seven daily rows on 2026-07-26; the earlier hard-failure is no longer reproducible.
- Enable **Branded Item Content Change Notifications** in DataDoe **Settings > Data tables**, then click Refresh once in Content Alerts and verify events/ASIN-to-brand attribution. Until then, the report intentionally shows an actionable setup error and makes no automatic request.
- Reconcile the first successful SKU P&L Analyzer refresh against Seller Central / the DataDoe Profit by SKU & Date export, including the reported currency, sales, profit, and COGS flags.
- Consider switching sales source from `b24cd69c06` (Profit by Date, settlement-based, roughly 7-day lag) to `401ffcd7e5` (Sales & Traffic by ASIN & Date, roughly 4-day lag, closer to Seller Central) if accuracy is off.
- Sidebar now includes Dashboard, Daily Reporting, Reconciliation, FBA Shipment Plan, SKU P&L Analyzer, and Content Alerts. Add later report modules only when the user defines their scope.
- Add Profit module for net margin analysis.
- Add PPC module for ad spend, ACoS, TACoS, and campaign performance.
- Add Inventory module for FBA stock, days-of-cover, and restock alerts.
- Currency conversion currently uses static approximate FX rates in `src/App.jsx`; consider wiring in a live FX API or creating a maintenance process for updates.
- Confirm product-brand labels in the catalog match the desired reporting taxonomy. They now come directly from Amazon/DataDoe catalog data rather than account-name heuristics.
- YoY comparisons require roughly 13 months of account history.
- The most recent 1-2 days of Amazon data may change as settlement data finalizes.
- README text currently displays mojibake for some punctuation in this environment; consider normalizing the file encoding if editing it later.

## Key decisions

- Source ID `b24cd69c06` was chosen initially for daily account-level rollup. Trade-off: it is settlement-based and can lag Seller Central by roughly 7 days. `401ffcd7e5` may match Seller Central more closely but has not been swapped in.
- Static FX rates are hardcoded in `src/App.jsx` for now. This is simple and free, but rates need periodic updates or a live API later.
- Brand filtering uses `product_brand` from DataDoe's catalog/product data, not account-name heuristics. Similar-looking product-brand labels will be treated as distinct until the underlying catalog data is corrected or an explicit mapping layer is added.
- Project files should remain under `sales-dashboard-live/` unless Vercel's Root Directory setting is changed too.
- The sidebar contains only implemented report modules; add additional report/module options only when requested.
- Vercel CLI should be run from the repo root, not from `sales-dashboard-live`, because the Vercel project already has Root Directory set to `sales-dashboard-live`. Running from the nested app folder makes Vercel look for `sales-dashboard-live/sales-dashboard-live`.
- Data policy for reports: all current and future reports should use the shared cache-first pattern (`cachedApiGet` / `readApiCache`) and should call DataDoe only on manual refresh. Do not add mount/view-change auto-fetching unless the user explicitly asks for it.
- Brand filtering is account-scoped. The selected account is the dashboard's primary scope; `Select All Brands` returns that account's overall figures, while a named product brand filters the same cached rows without another DataDoe request.

## Technical learnings

- The dashboard combines multiple Amazon accounts and supports account/brand selection, KPI cards, DoD/WoW/MTD/YoY comparisons, a sales trend chart, and account/brand breakdowns.
- The browser should never receive the DataDoe API key; all authenticated DataDoe requests go through the serverless API route.
- When running local dev, the Vite dev server proxies `/api` to `localhost:3000`, so `vercel dev` may be needed separately for API routes.
- DataDoe's export creation API rejects `sellerOrVendorIds` arrays with more than 5 elements. Any all-account, marketplace, or large-brand request must be batched server-side.
- `npm run build` currently succeeds, but Vite warns that the generated JS chunk is larger than 500 kB.
- DataDoe REST API rate limit is understood to be 2 requests/second per organization; excess requests may return HTTP 429 with `Retry-After: 1`.
- DataDoe exports are asynchronous: POST `/exports`, poll `/exports/{id}` until status is `COMPLETED`, then GET `/exports/{id}/raw`.
- DataDoe public schema confirmed the source IDs and fields for product-brand filtering:
  - `57a0cb319c10a395853afc0671579bf7ef0ff45d8a40c88ed9d2a5f61b4169a4` — **Profit by SKU & Date**. It is at child-ASIN/SKU/day grain and exposes `product_brand`, `total_sales`, `total_units_sold`, and `total_orders`.
  - `68d2de238e8d1a47bc56a981a99d54558507b0bafb1e09f1b3e95fb7750a17a8` — **Product Catalog by ASIN**. It exposes `child_asin`, `parent_asin`, `product_name`, and `product_brand` and is used to populate the complete brand selector.
  - The existing `401ffcd7e5` Sales & Traffic source has `child_asin` and `parent_asin`, but does **not** expose `asin`, `sku`, `brand`, or `brand_name` fields. Do not request those names from that source.
  - SKU-level sales must use DataDoe `groupBy` plus `aggregations` (date/account/currency/product_brand grouped; sales/units/orders summed). Fetching selected columns alone returns repeated SKU-level rows and can truncate the dashboard result.
  - Product Catalog by ASIN can be large (many product descriptions and ASINs). Do not cache/send the raw catalog in the browser response when only brand filtering is required; collapse it server-side to unique `product_brand` labels.
  - Daily Reporting validation on 2026-07-24 for AAKRITI ART CREATIONS IN: June 2026 totals from `action=daily` exactly reconciled to a direct `401ffcd7e5` Sales & Traffic export: `₹633,481.37` sales and `467` units across `20,779` ASIN-level rows. The API output contained `88` unique daily rows and no duplicate dates.
  - The Sales & Traffic source may expose a current zero-sales row before its sales/units finish loading. For example, July 23 had zero sales/units but nonzero ads. The Daily Reporting table must anchor on the latest date with completed sales/units rather than the maximum raw date.
  - Seller Central reconciliation on 2026-07-24, using the attached `C:\\Users\\laxmi\\Downloads\\788561020658.txt` Order Report for 2026-07-23: the report is for **Indya Store IN** and totals `INR 159,954.00` item price across 345 lines. It consists of `INR 137,346.00` shipped and `INR 22,608.00` pending; 22 cancelled lines have zero value. The deployed main dashboard's `action=brand-sales` route (source `57a0...`, Profit by SKU & Date) returned `INR 135,220.00`, 281 units, and 259 orders for the same account/date. The `INR 24,734.00` gap is primarily the pending order value (`INR 22,608.00`); the remaining `INR 2,126.00` is consistent with the source's settlement/profit-oriented adjustments rather than raw ordered item price. Do not claim these two report types should reconcile exactly.
  - The same live reconciliation found no 2026-07-23 rows in the `401ffcd7e5` Sales & Traffic by ASIN & Date source for any connected account, so it cannot currently provide yesterday's Seller Central total. This is source freshness/availability, not a frontend cache or aggregation defect.
  - Daily Reporting's configured advertising source `08cdc77d3d` returned `404 Source not found` from DataDoe on 2026-07-24 and then returned successfully through the deployed `action=daily` route on 2026-07-26 (seven AAKRITI daily rows for 2026-07-20 through 2026-07-26). Treat source availability as an upstream condition and keep validating the actual ad values rather than assuming the earlier 404 persists.
  - Main dashboard Order Line Items verification after deployment (2026-07-24): a full 420-day Indya Store refresh completed in 13.1 seconds and returned 5,539 date/brand rows. For 2026-07-23 it returned `INR 158,873.00` and `345` units. The attached Seller Central Order Report has the same `345` units and `INR 159,954.00`, leaving `INR 1,081.00` unexplained by dashboard logic. The DataDoe grouped data contains three units with zero order value, so the remaining difference is an upstream field-completeness delay, not the former shipped-versus-pending metric mismatch. Orders/AOV deliberately show unavailable for the new source because compact ASIN aggregation cannot deduplicate order IDs across ASINs without a substantially larger export.
- DataDoe API keys are shown only once at creation time. After that, only the prefix is visible in the UI.
- Vercel serverless functions cannot have spaces in the filename. A file named `datadoe (1).js` under `api/` would fail deployment with `invalid_function_name`; the active API route must remain `api/datadoe.js`.
- Changing Vercel environment variables does not auto-redeploy. Trigger a redeploy for new values to take effect.
- DataDoe AI Skills reference for Claude/Codex handoff and future report ideas: https://github.com/Deltologic/datadoe-ai-skills. Also review DataDoe Hub's AI skills/docs pages when designing new modules, especially reconciliation dashboards, orders manager, ASIN/search audit, export discovery, REST fallback, polling, and rate-limit guidance.
- Deltologic organization review (2026-07-26): use `datadoe-ai-skills` as the primary feature-blueprint library. Current directly relevant skills are `create-orders-manager`, `create-amazon-reconciliation-dashboard`, `weekly-sales-briefing`, and `amazon-asin-search-auditor`; read the exact `SKILL.md` before designing one of these modules. The organization also publishes `datadoe-mcp-codex`, a secure project-scoped Codex MCP template: keep the MCP key in an environment variable, configure the `datadoe` MCP server with `env_http_headers`, retain repo-specific agent rules/prompts, and never put the real MCP key in `.codex/config.toml`, source code, screenshots, or git history.
- SKU P&L Analyzer reference reviewed (2026-07-26): https://github.com/Deltologic/datadoe-ai-skills/tree/DOE-2733-skill-metadata-categories/skills/net-profit-pl-analyzer. Use the premium **Profit by SKU & Date** source (`57a0cb319c10a395853afc0671579bf7ef0ff45d8a40c88ed9d2a5f61b4169a4`) as the canonical P&L source because it already joins settlements, COGS, and advertising. Aggregate `total_sales`, `profit`, `total_cost`, `ad_spend`, `total_fees`, `cogs_total`, and `total_units_sold` by SKU/product/currency. Never sum ratio fields such as ACoS, TACoS, or ROI; recompute ratios from the summed amounts. Keep currencies separate, use full calendar months (fees settle in batches), rank by profit rather than sales, and flag negative profit, margin below half the blended margin, ad spend above profit, and suspiciously high margin as possible missing COGS.
- DataDoe source `aec3d5976911a7a80110c08801a741e4f0a25dd997d639f5d918284d905a4758` reviewed on 2026-07-27: **Branded Item Content Change Notifications** (`amazon_notifications_branded_item_content_change`). It is a Seller Central real-time event feed for A+ content / brand-registered ASIN changes, typically available within about two hours of Amazon publishing the change. Fields: marketplace and seller context, `sp_api_notification_id`, `sp_api_notification_type`, `event_time`, `notification_metadata`, and raw `payload`. It is useful for a future content-change alert/audit module, not sales, inventory, profit, or P&L reporting.
- Production source check (2026-07-27): DataDoe returned HTTP 400 because `Branded Item Content Change Notifications` is currently disabled for this organization. The dashboard route now turns this into an actionable HTTP 424 message rather than a generic server failure. Enabling the table in DataDoe **Settings > Data tables** is required before any notification events can be validated or displayed.
- Reconciliation dashboard source guide: https://github.com/Deltologic/datadoe-ai-skills/tree/DOE-2733-skill-metadata-categories/skills/create-amazon-reconciliation-dashboard. It requires six full calendar months and distinguishes order purchase dates from settlement posting dates; cross-month settlement is expected and must be labelled rather than treated as a discrepancy.
- Reconciliation source mapping verified live on 2026-07-26 for Indya Store IN: Order Line Items source `89b27535d27c2a94db5ae39af4717f542624ff4df7802fd633e16c78674a1778` supplies `amazon_order_id`, `order_date`, `amazon_order_status`, `fulfillment_channel`, `order_is_business`, `quantity`, `item_price_value`, and `item_tax_value`. Settlements source `732dac...` supplies the matching order ID, posting `date`, `settlement_type`, `item_price`, `item_tax`, `referral_fee`, `fba_per_unit_fulfillment_fee`, `refunded_amount`, and `total`. A real six-month request returned HTTP 200 and showed ORDER and REFUND events plus negative FBA/refund amounts as expected.
- A six-month order-level response can be larger than normal browser localStorage capacity (Indya Store's initial raw response was about 23 MB). Reconciliation uses IndexedDB (`upriver-report-cache`) for cache-first persistence, with localStorage only as a fallback. Do not return a per-brand monetary breakdown for every order: the server returns compact `brands` labels and uses `reconciliation-v2` cache keys.
- Reconciliation feature commits: `450d2ba Add Amazon reconciliation dashboard`; `37f0b0a Optimize reconciliation report caching`. Latest deployment: `https://upriver-dashboard-8928qt2rr-laxmikant1604s-projects.vercel.app` (2026-07-26), aliased to `https://upriverdashboard.vercel.app`.

## DataDoe reference (Deltologic GitHub) — reviewed 2026-07-26, for future features

Public org: https://github.com/Deltologic. Two repos are the most useful references for extending this dashboard:

- **`datadoe-api-starter`** (branch `development`) — official Next.js reference app on the DataDoe API. Mirror its patterns:
  - `src/lib/datadoe-client.ts` — canonical client. Confirms our conventions: `datadoe-api-key` header; on 429 read `retry-after` (our `ddFetch` already does this); responses/errors carry a `datadoe-api-request-id` header worth logging for support; error `message` can be an array (first = summary, full = details).
  - `src/app/api/datadoe/[...path]/route.ts` — a generic catch-all proxy that forwards any `/api/v1/*` path server-side. If we add more sources/actions, consider this pattern instead of one hand-written branch per action.
  - `src/types/api/exports.ts` — authoritative Exports request/response shape. **Capabilities we are NOT yet using but should:**
    - `filters: { combinator: "and"|"or", rules: [{ field, operator, value, not }] }` — server-side row filtering. This unlocks using **Order Line Items** with `amazon_order_status != "Cancelled"` for cleaner sales, or filtering an export to specific ASINs.
    - `dateInterval: "DAY"|"WEEK"|"MONTH"` — native period bucketing. The FBA Shipment Plan currently runs 3 separate month exports; one grouped export with `dateInterval:"MONTH"` + `groupBy:["child_asin"]` could replace them and cut refresh latency (the 25-40s risk).
    - `skip` (+ `limit`) — real pagination for large sources instead of a single large `limit`.
    - Real export statuses: `PENDING | IN_PROGRESS | COMPLETED | ERROR | BLOCKED_NO_TOKENS`. `pollExport` now treats `ERROR` and `BLOCKED_NO_TOKENS` (plus legacy `FAILED`) as terminal failures, so users receive the real upstream error instead of a misleading timeout.
  - `AGENTS.md` — build discipline for this API: read README first; run a `/util/sellers-and-vendors` health check before coding; keep features simple; feature-based folders under `src/features/<name>/`.

- **`datadoe-ai-skills`** (branch `development`) — 18 skill blueprints (`skills/<name>/SKILL.md`), each a ready feature spec with the exact source, columns, and formulas. Direct candidates for new sidebar modules: `restock-priority-alert` (inventory, overlaps our FBA plan), `net-profit-pl-analyzer`, `ppc-wasted-spend-watchdog` / `ppc-bid-optimizer-apply` / `ppc-negative-keyword-applier`, `keyword-rank-sqp-tracker`, `sales-movers-scanner`, `return-refund-analyzer`, `buy-box-loss-root-cause`, `suppressed-inactive-listings-check`, `daily-account-health-check`, `weekly-business-review`, `create-orders-manager`, `create-amazon-reconciliation-dashboard`, `amazon-listing-optimizer`.
  - `restock-priority-alert` validates our FBA plan design (same `amazon_fba_inventory_health` source, latest-snapshot/MAX(date), inbound-aware, skip dead stock). It surfaces extra fields we could add later: `days_of_supply`, `units_shipped_t7/t30`, `fba_inventory_level_health_status`, and Amazon's own `recommended_ship_in_quantity` / `recommended_ship_in_date` (worth showing next to our computed Recommended Shipment as a cross-check). Note quirks it flags: `days_of_supply` is often null for slow SKUs (fall back to t30 velocity); FBA Inventory Health is not available in MX.

- There is also a hosted MCP server (`Deltologic/datadoe-mcp`, base `https://mcp.datadoe.com/mcp/v1`) exposing the same data as MCP tools — an alternative to the REST exports flow if we ever want tool-based access.

### Report opportunity review (2026-07-29)

DataDoe's published skill catalogue was rechecked at
https://github.com/Deltologic/datadoe-ai-skills and its public data scheme at
https://api.datadoe.com/api/v1/spec/data-scheme. The current Upriver modules
already cover Dashboard, Daily Reporting, Reconciliation, FBA Shipment Plan,
SKU P&L, Keyword Rank, and Content Alerts (pending the source being enabled).
Do not build duplicates. Recommended next modules, in priority order, are:

1. **PPC Performance & Wasted Spend:** campaign/ASIN/keyword/search-term
   performance, spend, attributed sales, ACoS/TACoS, zero-sale click waste,
   break-even breaches, and concrete bid/negative-keyword suggestions. This is
   the highest-value next module because shared daily Ads history is already
   persisted in Supabase. Preserve campaign type; Search Term data is SP+SB,
   while Keyword Targeting is SP+SB+SD.
2. **Returns & Refund Leakage:** SKU/ASIN returns, refund value, return rate,
   reason buckets, COGS/profit impact, and money-ranked fixes. It identifies
   whether the best action is product, sizing, listing, or delivery work.
3. **Sales Movers & Weekly Business Review:** week-over-week SKU gains/losses
   diagnosed by traffic, conversion, price, buy box, ads, margin, and stock;
   paired with a compact owner/manager weekly summary and actions.
4. **Listing Health / Suppressed Listings:** inactive, incomplete, suppressed,
   stranded, or error-state SKUs ranked by sales at risk; prevents silent sales
   loss. Add Buy Box root-cause as a drill-down for price, availability, and
   fulfilment causes.
5. **Account Health Monitor:** Account Health Rating, order-defect, late
   shipment, valid tracking, cancellation, and policy violations against
   Amazon targets. This is a risk-prevention report, not a sales report.
6. **Orders Manager:** searchable order/line-item operations view with order
   status, FBA/FBM, business order, geography, product/SKU, and local workflow
   tags. It is best for customer-service and operations teams.
7. **Listing / Search Optimizer:** combines SQP, catalog and listings to show
   search-funnel gaps, title/content quality, and ASIN search visibility. Use
   only after the team is ready to act on copy/content changes; it is less
   urgent than PPC, returns, or listing health.

Important data limits: Order Line Items are near-real-time but can be delayed
up to about an hour; Sales & Traffic can lag up to four days; Profit/settlement
metrics are better for settled profitability than same-day ordered sales; Ads
attribution should continue to be re-upserted over its rolling correction
window. Keep currency separate, use shared Account/Brand scope, read Supabase
snapshots first, and make external DataDoe refreshes controlled rather than
per-browser.

**Approved next-report roadmap (2026-07-29, planning):** user selected six
new read-only modules: PPC Performance & Wasted Spend, Returns & Refund
Leakage, Sales Movers, Listing Health / Suppressed Listings, Buy Box Loss, and
Listing & Search Optimizer. Build in phased, independently verified commits:
first shared insight/alert primitives plus Sales Movers, Listing Health and
Buy Box; then Returns; then PPC from persisted Ads data; then Listing/Search
Optimizer; then an optional cross-report priority feed. Every module must use
the existing global Account/Brand header scope, server-enforced permissions,
shared Supabase snapshot/cache-first behavior, explicit refresh only, and
mobile-safe tables. The requested "AI" experience means evidence-bound,
deterministic insights: severity, money/revenue at risk, named contributing
metrics, data freshness/confidence, and a recommended action. Do not generate
unsupported claims or use any Amazon write action without a later explicit
approval. Claude/Codex must read each referenced DataDoe `SKILL.md` and the
data scheme before implementation, update this memory after every stage, run a
senior code review, deploy only after source-level and browser-level checks.

**Six-report senior review (2026-07-29, remediation completed locally):**
`npm run verify` now passes 49 assertions and a full non-tree-shaken Vite build.
Review fixed the following correctness risks before merge:

- PPC rollups now include currency in their identity, so a campaign/ASIN/target
  or search term reported in multiple currencies never has its money or ratios
  combined. Account-wide PPC KPIs and TACoS are intentionally unavailable for a
  multi-currency scope rather than fabricated; the UI labels this distinction
  accurately instead of describing it as an export failure.
- Priority Feed uses campaign-level PPC insights only. Search-term, target and
  ASIN views overlap that campaign spend and remain drill-down views, so adding
  them to the feed would double-count waste.
- Pagination of persisted Ads source rows is now ordered by metric date plus
  its remaining primary-key fields (`source_key`, marketplace and
  `dimension_key`). This makes PostgREST pages deterministic when an account has
  more than 1,000 rows on a single date, preventing a partial or repeated PPC
  rollup.
- The cross-midnight fallback serves a saved snapshot only if its stored
  `reportVersion` matches the currently requested metric schema. A future report
  version change therefore cannot render an old payload under a new definition.

Live DataDoe validation for one IN and one US account, plus signed-in browser
and mobile validation, remain required before production deployment.

**Marketplace-aware dashboard foundation (2026-07-29, ready to deploy):**
`sales-dashboard-live/lib/marketplaces.js` is the single source of truth for
marketplace country, default currency, numeric locale and IANA timezone. It
covers the current IN/US/CA/AU accounts and the UK plus Amazon Europe
marketplaces (DE, FR, IT, ES, NL, BE, IE, PL and SE), with safe profiles for
other supported marketplaces. `fetchAccounts` now returns normalized country,
currency, locale and timezone metadata. Every report window derives its
date-only `to` value from the *selected account's marketplace day*, preventing
an India-based user from requesting tomorrow's US/Canada data near midnight (or
the reverse). Display money respects the currency locale, dashboard breakdowns
no longer hard-code INR, and content-alert timestamps use the selected
marketplace timezone. This is intentionally account-scoped: currencies are
still never converted or combined. Validation: 50 insight assertions and the
full Vite build pass. **Production deployment completed 2026-07-29:** commit
`543f35f` deployed as `dpl_87uT8Qmjapc8MwmWbsZCW5QQcmZ8` in 18 seconds;
Vercel reports it Ready and aliases it to `https://upriverdashboard.vercel.app`.
The public URL returned HTTP 200 after deployment. Remaining operational QA is
to sign in and refresh one account each for IN, US, CA, AU and an EU marketplace
when those accounts are connected, confirming DataDoe's returned country/currency
matches the normalized account profile.

## Dashboard authentication and account access (implemented and deployed 2026-07-29)

### What is implemented

- Supabase email/password authentication gates the entire browser app. The
  Vite bundle uses only `VITE_SUPABASE_URL` and the public/anon key; it never
  receives `SUPABASE_SECRET_KEY` or `DATADOE_API_KEY`.
- The initial administrator is **`laxmikant@upriver.in`**. Migration
  `20260729_dashboard_auth_and_access.sql` creates an Auth-user trigger that
  makes this email `admin`; all invited users become `viewer` by default with
  no Amazon account access. The migration is applied to production.
- The sign-in screen permits only this initial owner email to create the first
  administrator login. Every other person must be invited from the admin-only
  **User Access** sidebar page.
- The User Access page invites an email, lets the admin choose a Viewer or
  Editor role, and assigns zero or more individual Amazon accounts. It lists
  current users and lets the admin change a non-admin user's role/assignments.
  The initial administrator is deliberately protected from alteration there.
- `api/datadoe.js` now authenticates every request with the Supabase access
  token. For every account-scoped action it validates `ids` on the server
  against `account_permissions`; changing a browser URL/request cannot expose
  an unassigned account. The `accounts` action filters the returned account
  directory too. Diagnostic `fields`/`sample` actions require admin.
- Browser report caches are now namespaced by Auth user ID (`v2` cache keys),
  and both localStorage and IndexedDB report entries for revoked accounts are
  removed when a user's access is loaded. Server authorization remains the
  final control.
- `api/access.js` is the admin-only invitation/access-management endpoint.
  It uses the server-only Supabase secret to call the Auth Admin API; it does
  not expose user-management capability to the browser.

### One-time operational setup after deployment

1. In Supabase Studio, open **Authentication > URL Configuration**.
2. Set Site URL to `https://upriverdashboard.vercel.app`.
3. Add `https://upriverdashboard.vercel.app/**` to Redirect URLs.
4. On the dashboard login page, choose **Create initial administrator login**
   and sign up using `laxmikant@upriver.in`. Confirm the email if Supabase asks.
5. Sign in, open **User Access**, load the account directory once, invite each
   user, and tick only the accounts that user should access.

**Observed setup issue (2026-07-29):** the first administrator confirmation
email redirected to `http://localhost:3000` and then showed
`error_code=otp_expired`. This confirms Supabase Auth URL Configuration has not
yet been changed from its local-development default and that specific email
link is no longer usable. Set the Site/Redirect URLs above first, then request
a fresh confirmation email from the production dashboard. Do not troubleshoot
the old link or start a localhost server merely to complete it.

**Bootstrap hardening (completed and deployed 2026-07-29):** the login screen
queries a public, non-sensitive `bootstrap-status` response from the existing
access API. The one-time administrator-create control is shown only when no
Auth user exists for `laxmikant@upriver.in`; if the status request fails, the
control stays hidden. The database trigger remains the authority: only that
exact email is assigned the admin role, so no other email can self-register as
administrator. Commit `75a3e9f Hide completed administrator bootstrap` is
deployed. Production verification returned HTTP 200 with
`{"initialAdminExists":true,"confirmationPending":false}`, proving the owner
account exists and is confirmed; the live login page should therefore hide the
bootstrap action after a hard refresh.

**Login UI cleanup (completed 2026-07-29):** removed the explanatory
"Administrator setup is already in progress or complete" text from the login
screen. The bootstrap action remains hidden after initial setup; this is a
presentation-only change and does not weaken the server-side administrator
protection.

**Session persistence fix (implemented 2026-07-29):** the browser Supabase
client now uses explicit first-party
`localStorage` using `upriver-dashboard-auth-v1`, with persistent refresh
tokens enabled. App startup now attempts `refreshSession()` only when
`getSession()` reports an error, so a recoverable expired access token is not
treated as a logout. Existing users will need to sign in once after this
storage-key migration; subsequent browser refreshes should keep them signed in
unless they explicitly sign out, clear browser site data, or their Supabase
session is revoked. `npm run build` passed; end-to-end refresh verification
requires a signed-in browser session and must be performed by the dashboard
owner after deployment.

`DASHBOARD_APP_URL=https://upriverdashboard.vercel.app` is configured in
Vercel Production for invitation redirects. Supabase Auth settings showed
email signup enabled and email confirmation enabled on 2026-07-29. The
production dependency audit after adding `@supabase/supabase-js` found zero
production vulnerabilities; do not run `npm audit fix --force` casually.

**Deployment verification:** feature commit `de5327e` deployed as
`https://upriver-dashboard-m6rs943xe-laxmikant1604s-projects.vercel.app` and
is live at `https://upriverdashboard.vercel.app`. Production homepage returned
HTTP 200; a request to `/api/datadoe?action=accounts` without a Supabase access
token returned HTTP 401 `Please sign in to access the dashboard.` This confirms
the previous anonymous data API is no longer accessible.

## Amazon accounts inventory

## Account-scoped brands and Brand View (2026-08-02; HTTP 402 fallback deployed)

### Completed locally

- **Account selector brand isolation:** the header Brand dropdown now derives
  its values only from saved `brand-sales` rows whose `ids` cache parameter is
  exactly the selected account. It no longer trusts broad Product Catalog
  metadata, which could make brands from another account appear in the
  selected account dropdown.
- `action=brand-sales` now also returns `catalogBrands` derived from its
  already-joined selected-account sales rows rather than the raw catalog
  export. The browser and API therefore enforce the same scope boundary.
- **Dashboard mode switcher:** the Dashboard header now has `Account view`
  (the existing account/brand dashboard) and `Brand view`. Other report pages
  remain account-scoped and their existing header behavior is unchanged.
- **Brand View:** a separate portfolio view lets a user choose one brand and
  shows a country/currency snapshot and a seven-day country-performance table
  across all accounts that user is allowed to access. Country labels use the
  existing marketplace flags and standard region names.
- Brand View is cache-first and manual-refresh only. Its one refresh action
  walks accessible accounts sequentially, reuses the existing
  `action=brand-sales` API, saves each account response and saves the combined
  portfolio response in the signed-in user's browser cache. It must not be
  changed to background-fetch or parallel requests because that would spend
  DataDoe tokens and can violate the organisation-wide rate limit.

### Important decisions and limitations

- Brand View **never combines or converts money across currencies**. It groups
  sales by marketplace country and currency; percentage share is calculated
  only within the same currency. The summary intentionally says "Sales
  reporting: By country" rather than inventing a portfolio total.
- It shows only sales and units because the current manual portfolio refresh
  fetches only the proven Order Line Items + Product Catalog mapping. FBA
  inventory, ad spend and TACoS remain withheld until a dedicated country-level
  portfolio data source is fetched and reconciled; no account-level ad or FBA
  value may be relabelled as a brand value.
- A first Brand View refresh may take several minutes for many accounts because
  it checks them one at a time. Progress is visible in the page. Subsequent
  opens and date/filter changes use saved browser data and make no DataDoe API
  call.
- **First-use brand dropdown follow-up:** a new browser could have no saved
  brand-sales response, leaving the Brand View dropdown empty. Brand View now
  presents an explicit `Load portfolio brands` action (and enables the header
  refresh button with the same purpose when no brand is selected). It manually
  reads each permitted account sequentially, stores the responses, then fills
  the dropdown. It never runs on navigation or automatically.
- While Brand View is active, the sidebar intentionally contains only `Brand
  Dashboard`; switching back to Account View restores the full application
  navigation. Brand View itself now contains only the three requested
  country-level reports: `Country Snapshot`, `Monthly Country Snapshot` (six
  months plus current-month run rate), and `7-Day Country Performance`.
- **Catalog directory correction (2026-08-02):** the former first-use loader
  scanned 14 months of `brand-sales` for every account. That was slow and
  could leave the picker empty for a long time. The manual loader now calls
  `GET /api/datadoe?action=brand-directory&ids=<allowed-account-ids>`, which
  fetches only Product Catalog brand names. The server checks every requested
  account against the signed-in user's permissions, partitions primary and
  secondary DataDoe account IDs by connection, batches export IDs in groups of
  five, and returns one sorted, deduplicated global brand list. Neither API
  key reaches the browser.
- The returned directory is cached per signed-in user and exact allowed-account
  signature. On Brand View it is read from cache first; only `Load portfolio
  brands` or the header refresh button with no selected brand calls DataDoe.
  A changed account-access scope clears an unmatched directory cache so brands
  from a previous user's scope cannot remain visible.
- **HTTP 402 fallback (2026-08-02):** production returned `DataDoe export
  status check failed (402)` during the catalog directory request. The server
  now checks the latest shared snapshot for the permitted account under the
  Sales Movers, Listing Health, Buy Box Loss, Returns, PPC, and Listing
  Optimizer report keys before creating any Product Catalog export. Those
  snapshots already contain `catalogBrands`, so the picker can populate with
  no DataDoe request when prior report data exists.
- If no shared snapshot has a catalog brand list and DataDoe still returns
  HTTP 402, the UI now surfaces a specific operational message: the Product
  Catalog export needs available DataDoe credits or an enabled source. This is
  an upstream billing/source-access condition, not a browser dropdown bug;
  no code can truthfully generate catalog brands when neither DataDoe nor a
  prior saved catalog is available.
- HTTP 402 fallback commit **`fd7a2e9`** (`Fallback brand directory to shared
  snapshots`) is deployed as
  `https://upriver-dashboard-3p5c9ibvn-laxmikant1604s-projects.vercel.app`
  and assigned to the stable production alias. Vercel completed a full nested
  app build and deployed the updated `api/datadoe` serverless function.
- `npm run verify` passed after implementation: 53 deterministic assertions
  and the full Vite build (1,071 kB main bundle; existing chunk-size warning
  remains only a performance follow-up).
- Feature commit **`7f23e9a`** (`Add account scoped brand portfolio view`) is
  pushed to `origin/main`. Vercel auto-deployment was verified on the stable
  production URL: the deployed JavaScript contains `brand-portfolio-v1`,
  `Brand View`, and `Portfolio brand` markers. Production URL:
  https://upriverdashboard.vercel.app
- Follow-up commit **`9b32811`** (`Load portfolio brands on demand`) is pushed
  and deployed. Vercel deployment **`dpl_8qvfndtCsGjZv4LQBakSGVcwNQ4p`** is
  assigned to the stable production alias. A production JavaScript check found
  both the `Load portfolio brands` and `Monthly Country Snapshot` feature
  markers.
- Catalog-picker commit **`8bdb782`** (`Load brand picker from catalog
  directory`) is deployed as Vercel deployment
  **`upriver-dashboard-9ebf3pjlq-laxmikant1604s-projects.vercel.app`** and
  assigned to `https://upriverdashboard.vercel.app`. The production bundle
  contains the `brand-directory` marker, confirming the public site serves the
  new picker route.

### Vercel deployment learning (2026-07-31)

- The Git-triggered deployment created for commit `9b32811` was `READY` but
  built the repository root in `0ms` and served an older frontend bundle. This
  indicates the Vercel project Root Directory setting is currently not being
  applied correctly to the Git integration, despite the local nested project
  link recording `rootDirectory: sales-dashboard-live`.
- The successful corrective deployment was run from the **repository root**
  with `npx vercel --prod --yes --scope laxmikant1604s-projects`; that command
  correctly applied the configured `sales-dashboard-live` root once, built
  Vite (2,384 modules), and updated the stable alias. Do not run that command
  from inside `sales-dashboard-live` while the Vercel project still has this
  Root Directory value, because it attempts the invalid nested path
  `sales-dashboard-live/sales-dashboard-live`.
- In Vercel Settings -> General, confirm the project Root Directory is exactly
  `sales-dashboard-live` and save/reconnect the Git integration if future
  auto-deploys again show a `0ms` root build. Verify every deployment by
  checking the public bundle for a newly added UI marker before reporting it
  live.

## Shared DataDoe source reuse (implemented and deployed 2026-08-04)

### Completed

- Added `lib/server/source-contracts.js` as the canonical source/semantic
  registry. It maps every existing report to its DataDoe sources and records
  each source's native grain and valid fields. Future reports must declare
  their dependencies here before scheduled activation.
- Added exact source-export reuse to the shared `fetchExportRows()` transport.
  This automatically covers every current/future report that uses the common
  DataDoe helper. The cache identity includes the DataDoe organisation hash,
  exact account scope, canonical source, columns, date range, grouping,
  aggregations, ordering and row limit. Only identical exports can collide.
- Concurrent requests for the same export now share one in-flight Promise, so
  two users opening compatible reports together cannot create two exports.
- Successful exports below their row cap are cached in the existing private
  `dashboard-snapshots` Supabase Storage bucket. Postgres stores only compact
  lookup metadata in `source_export_cache`; report rows do not increase the
  already-constrained database size. Objects above 8 MiB are deliberately not
  cached, and cache retention is capped at 512 MiB / 512 entries with expiry.
- Source payloads are available only to server functions using the Supabase
  service role. API keys, raw keys and raw account IDs are not stored in cache
  metadata; organisation and account scope use SHA-256 fingerprints. Transport
  remains HTTPS and Supabase provides encrypted storage at rest.
- Added migration `20260806_shared_source_export_cache.sql` and deterministic
  tests in `scripts/test-source-cache.mjs`. `npm run verify` now includes these
  checks. Verification passed: 54 insight + 60 Brand View + 23 sync + 6 source
  cache assertions and the full 1,121 kB production build.
- The migration was applied to production Supabase on 2026-08-04. A live
  service-role round trip uploaded a synthetic private Storage object, read it
  through `source_export_cache`, then expired and pruned both test objects.
  This verified the REST metadata, private object upload/download and cleanup
  path end to end without using a DataDoe token.
- Feature commit **`02ce7d9`** (`Reuse shared DataDoe source exports`) is
  pushed to `origin/main`. Production deployment
  **`dpl_Cp5VTqe2KHSi62LLC4woGrcG8dj9`** is READY at
  `https://upriver-dashboard-h50cfeliu-laxmikant1604s-projects.vercel.app`
  and aliased to https://upriverdashboard.vercel.app. Production verification
  returned HTTP 200 with bundle `assets/index-CKwRf7FW.js`; the unauthenticated
  DataDoe route still returns HTTP 401.

### Important decisions and technical learnings

- Reuse is based on source semantics, not a report label. Order Line Items can
  power ordered sales/units in Dashboard, Reconciliation and future compatible
  views, but it cannot replace Sales & Traffic where sessions, page views or
  conversion decomposition are required. Sales Movers therefore still needs
  Sales & Traffic for its driver analysis.
- FBA Inventory Health, Listings/AWD, Ads, Profit/COGS, Settlements, Returns,
  Product Catalog and SQP remain distinct canonical sources. Their identical
  export signatures are reused globally, but their metrics are never mixed.
- Ads is already source-first: its four daily source datasets are persisted in
  `ads_daily_source_rows` with correction-window upserts. The generic cache is
  complementary; it does not replace Ads history or its late-attribution logic.
- A response exactly on the DataDoe row cap is never persisted because it may
  be truncated. Existing strict report guards still fail rather than present
  partial totals.
- Persisted cache expiry is honoured exactly in the in-process LRU. Scheduled
  jobs also skip optional Storage persistence with less than three seconds of
  execution budget, preserving the 60-second Vercel deadline.
- This release removes duplicate *identical* exports immediately. Partially
  overlapping requests (different columns, grain or windows) are intentionally
  separate until a report is migrated to a shared canonical fact shape; merging
  them automatically would risk incorrect metrics.

### Pending after this release

- Measure `source_export_cache` hit rate and Storage growth after several daily
  cycles, then tune per-source TTLs from evidence.
- Migrate the highest-value overlapping shapes incrementally: Product Catalog
  superset, FBA Inventory snapshot, then a bounded ASIN/day sales fact. Reconcile
  every derived report exactly before removing its old export signature.
- FBA Plan and the remaining disabled scheduler adapters still need
  checkpointable builders before scheduled activation. This cache reduces
  duplicate work but does not make a multi-export report fit a single Vercel
  function by itself.

## Automated Amazon Ads persistence (implemented 2026-07-29; deployment pending)

The three requested Amazon Ads reports now have a server-side, cache-first
foundation. The code is ready to deploy and the Supabase migration has already
been applied to the production `upriver-shared-data` database.

- **Campaign performance**: `08cdc77d3dc24a7651553e2e926f598188c66172f64cd6512265900af6073a6c`.
  This is persisted at campaign/day grain and also upserts the compact
  `ad_daily_metrics` table used by Daily Reporting, so saved campaign metrics
  can be read without another DataDoe advertising export.
- **ASIN performance**: `d0017e92fb089c2c8c3fe65f81d08666ecb4fe937ffbce9969ce2fc7d28c805c`.
  This is persisted at its native ASIN/campaign/ad/day grain.
- **Keyword Targeting performance**: `bbba3d213ac78ccbaf22cfa68eecb3f475641f49da26d51d1ac36446310051e3`.
  This is persisted at its native targeting/keyword/campaign/ad-group/day
  grain, retaining `ad_campaign_type` so SP/SB/SD are not mixed blindly.

### Automation behavior

- `sales-dashboard-live/api/ads-sync.js` discovers the authoritative DataDoe
  account list every scheduled run. Existing accounts and accounts connected in
  the future are included automatically; no account list is hard-coded.
- Supabase tables `ads_daily_source_rows` and `ads_sync_state` were created by
  migration `20260729_automated_ads_sync.sql`. Upserts use each report's
  natural dimensions plus account/marketplace/date, so daily and monthly
  re-fetches correct attribution instead of double-counting it.
- Initial history is imported once per account/source: 56 days for campaign and
  targeting, 60 days for ASIN. Later runs re-fetch the latest 21-day correction
  window daily and the last 49 days about once every 25 days.
- A hard 50,000-row export cap is never accepted as complete: the worker splits
  a date range and retries smaller windows. DataDoe calls are spaced at least
  ~550 ms and retry HTTP 429 responses to respect the organization limit.
- A database lock prevents overlapping work for the same country/source scope.
  `CRON_SECRET` is stored only in Vercel Production and protects every cron
  endpoint; it must never be copied into source, docs, screenshots, or git.

### Country schedules (all cron expressions are UTC)

Each source gets its own bounded job so a large ASIN/targeting export cannot
block the compact campaign export. Vercel Hobby can run up to 100 daily jobs,
but has hourly (up to 59 minute) scheduling precision.

| Marketplace scope | Campaign | ASIN | Targeting | Intended local morning |
| --- | --- | --- | --- | --- |
| India (`IN`) | 00:30 UTC | 01:30 UTC | 02:30 UTC | approximately 06:00 / 07:00 / 08:00 IST |
| US + Canada (`US`, `CA`) | 10:00 UTC | 11:00 UTC | 12:00 UTC | approximately 06:00 / 07:00 / 08:00 US Eastern during daylight saving |
| Australia (`AU`) | 20:00 UTC | 21:00 UTC | 22:00 UTC | approximately 06:00 / 07:00 / 08:00 AEST |
| Other future countries | 06:00 UTC | 07:00 UTC | 08:00 UTC | fallback; not guaranteed 06:00 local |

The application chooses country membership dynamically. The scheduled UTC
times are intentionally documented as *approximate*: Vercel Hobby may invoke
any time during the requested hour and does not provide DST-aware local-time
scheduling. A Vercel Pro/external timezone-aware scheduler is required if
exact 06:00 local time becomes a business requirement.

### Current implementation status

- Supabase migration applied successfully and verified: the new tables are
  present alongside the existing dashboard tables.
- Vercel Hobby permits **at most 12 Serverless Functions per deployment**. The
  first two scheduler deployment attempts failed only after a successful build
  because 12 separate cron handlers plus existing API files exceeded that
  limit (`exceeded_serverless_functions_per_deployment`). This is now resolved
  in code: server-only helpers live under `lib/server/`, and one dynamic
  `api/cron/[scope].js` function serves all 12 scheduled country/source paths.
  Do not recreate one API file per schedule on this Hobby project.
- **Production deployment is live:** the scheduler code from commit `a8a3fb7`
  is live through the stable alias `https://upriverdashboard.vercel.app`.
  Vercel API metadata confirms `READY`, alias assigned, and exactly **12**
  registered cron jobs. The latest deployment record is documentation commit
  `6824110`; it carries the same scheduler code.
- Production health check returned HTTP 200. A direct request without the
  secret correctly returned HTTP 401, proving the cron route is not public.
  Vercel supplies the stored `CRON_SECRET` authorization header to scheduled
  invocations. The secret is intentionally unavailable from `vercel env pull`,
  so do not weaken the endpoint merely to test it manually.
- The first real scheduled DataDoe worker result still needs observation in
  Vercel Cron logs / `ads_sync_state` after its next country time. Until the
  first campaign seed succeeds for an account, Daily Reporting will show no
  saved Ads metrics for that account rather than launch an unplanned DataDoe
  Ads export.
- The existing browser report cache remains in place. New Ads data is shared
  server-side now; other report families will be migrated to shared Supabase
  snapshots incrementally, using the same no-automatic-DataDoe-fetch rule.

- 15 total accounts were previously observed through DataDoe.
- Marketplace count observed: IN (7), US (5), AU (1), CA (1), plus 1 US-marketplace account labelled "AU" in DataDoe data.
- Accounts with Amazon Ads connected: Indya Store IN, Haven&Hue US, JustHuman IN, Sashaa World IN, AAKRITI ART CREATIONS IN.
- Treat DataDoe's `/util/sellers-and-vendors` endpoint as authoritative for the current account list.

## How to resume cold

## Scheduler v2 foundation review (Codex, 2026-08-05)

- Branch `feature/scheduler-v2` contains the initial Scheduler v2 foundation in
  commits `0563d3e`, `4469e70`, and `ede505f`. It has not been pushed, merged,
  deployed, or approved for Phase 1b yet.
- **Blocking migration defect:**
  `sync_source_jobs_one_attempt check (create_export_count <= 1 or attempted_at
  is not null)` does not cap attempts at one. Any count above one passes after
  `attempted_at` is set. Enforce `create_export_count` in `0..1` and consistency
  between the count and `attempted_at`; add a database-level test for it.
- **Incorrect cycle timing semantics:** `open_sync_cycle` currently inserts a
  `running` cycle with `started_at = now()`. Kickoff is only an enqueue action,
  so it must create an idempotent `pending` cycle with no actual start time.
  A separate atomic worker-claim transition must set `running` and
  `started_at` when processing really begins.
- **Incorrect dependency-map statement:** `SCHEDULER_V2.md` says Dashboard /
  `brand-sales` uses Sales & Traffic by ASIN & Date. Current production code in
  `buildBrandSalesPayload` actually uses Order Line Items source
  `89b27535...` plus Product Catalog `68d2de...`. FBA Plan separately uses
  Sales & Traffic source `401ffcd7e5`. Correct the map from the executable
  contracts before extracting Phase 1b registry declarations.
- **Verification blocker:** direct Windows access/execution of
  `scripts/test-scheduler-v2.mjs` hangs (`node --check` times out), although its
  committed Git blob is readable and its source can be inspected. Recreate or
  otherwise normalize this file and prove `npm run test:scheduler-v2` plus the
  full `npm run verify` run normally from the checked-out worktree. The current
  handoff's verify-green claim is not independently reproducible yet.
- Do not continue Phase 1b until these four items are fixed in small local
  commits and re-reviewed. Keep `feature/design-system` untouched.

### Scheduler v2 correction re-review (Codex, 2026-08-05)

- Commits `549679e`, `6352d90`, and `4d26c95` correctly repair the SQL
  one-attempt constraint, separate enqueue time from the atomic worker-start
  transition, and correct the source dependency map. Those three code/document
  corrections passed static senior review.
- One verification blocker remains on this checkout:
  `scripts/test-scheduler-v2.mjs` still cannot be read, syntax-checked, or
  renamed through its worktree path. `node --check` and `git mv` both time out,
  while the committed Git blob is readable and contains the expected expanded
  22-assertion suite. No lingering project Node/Git process was found holding
  the path. Therefore the handoff statement that the suite is worktree-runnable
  is not reproducible in Codex's environment.
- Before Phase 1b, remove/recreate the problematic filesystem entry under a new
  name such as `scripts/scheduler-v2.test.mjs`, update `package.json`, and prove
  `node --check`, the scheduler test, and full `npm run verify` from this same
  checkout. Do not merely rewrite the same path again.

### Scheduler v2 foundation approved (Codex, 2026-08-06)

- Commit `f8d18a3` removed the old tracked test path and preserved the expanded
  suite as `scripts/scheduler-v2.test.mjs`; `package.json` and documentation now
  reference that path.
- Codex's managed Windows sandbox still times out on direct filesystem commands
  whose path contains `scheduler-v2`, including the new name and even a probe of
  the removed name. Neutral filenames work normally. This is an environment
  path-interception anomaly, not a JavaScript assertion failure.
- Codex independently executed the exact committed test blob in memory with its
  real planner, registry, migration, and `api/datadoe.js` dependencies: all 22
  Scheduler v2 assertions passed. The remaining suites also passed directly:
  54 insight, 60 Brand View, 23 sync, 6 source-cache, and the full Vite
  `build:check` (2,393 modules; expected complete-dashboard bundle warning).
- The corrected SQL one-attempt invariant, pending-to-running cycle claim, and
  executable-code-backed source map are approved for the foundation stage.
  Phase 1b may proceed on `feature/scheduler-v2`; live Postgres concurrency and
  controlled per-organization DataDoe probes remain later rollout gates. Do not
  push, merge, deploy, or apply the migration yet.

### Scheduler v2 Phase 1b partial review (Codex, 2026-08-06)

- Commits `420101b`, `5026038`, and `d72497a` were reviewed. The extraction of
  `sourceRequestIdentity` is byte-compatible with the previous implementation;
  its 7 parity/golden-hash assertions pass. The declared constant sets for
  `brand-sales` and `sku-pl` match their current executable builders; their 10
  declaration tests pass.
- **Phase 1b is not yet approved to expand to the remaining reports.** The live
  transport in `fetchExportRows` chunks seller/vendor IDs into groups of at most
  five and computes one request hash per chunk. `reportSourceRequestHashes`
  currently hashes the complete supplied ID array once per source/window. For
  six or more IDs it therefore declares a source job that no real DataDoe export
  creates, undermining exact cache parity and the one-attempt-per-export ledger.
  Its tests cover only one or two IDs and do not exercise the API cap.
- The resolver also applies every supplied window to every source contract. That
  happens to work for the two first declarations (brand-sales shares one window;
  sku-pl has one source), but it becomes an incorrect Cartesian product for
  reports whose sources use different windows/no-date snapshots, including FBA
  Plan. Each contract needs an explicit request/window key and only its own
  concrete windows before the remaining reports are declared.
- Required correction: share the five-ID batching primitive with the live
  transport, emit one identity per real chunk, return no requests for an empty
  scope, add 5/6/11-ID parity tests against `fetchExportRows` semantics, and
  replace the global `windows` list with contract-keyed concrete windows. Then
  re-run the full verification and return for review before adding more report
  declarations. No push, merge, migration, or deployment.

### Scheduler v2 Phase 1b resolver approved (Codex, 2026-08-06)

- Commits `c46deef`, `9877e21`, and `1d03690` correct the resolver findings.
  The live DataDoe transport and scheduler now share the dependency-free
  five-ID batching leaf; resolved source jobs carry their exact account chunk,
  identity fields, export options, and stable request key. Windows are bound to
  their own request keys rather than multiplied across every source.
- Codex independently passed the 23 report-contract boundary assertions (0, 1,
  5, 6, and 11 IDs; exact chunk membership/hashes; keyed windows; no-date
  isolation; org isolation), the 7 source-identity assertions, the 6 shared
  source-cache assertions, and `build:check` (2,393 modules).
- The resolver is approved for the remaining Phase 1b declaration work. One
  non-blocking edge should be fixed before those declarations expand: currently
  window-key validation occurs before the empty-ID early return. Move the empty
  scope check ahead of window validation so an account resolving to no raw IDs
  produces no jobs rather than a missing-window error. Add a test for empty IDs
  with an empty/missing window map.
- Continue only Phase 1b declarations and parity tests. Do not begin Phase 1c,
  push, merge, deploy, or apply migrations. Live DataDoe and Postgres gates
  remain outstanding.

## Brand View Country Snapshots (implemented 2026-08-03)

- Brand View now uses the shared `brand-portfolio-shared-v3` report rather
  than rebuilding its tables independently in every browser. A manual Brand
  View refresh aggregates only the selected brand's mapped accounts, stores
  the compact portfolio payload in Supabase, and makes the same result
  available to every user who is allowed to access those accounts.
- Normal Brand View loads read this one shared Supabase snapshot and never
  start a DataDoe export. The shared build itself reads only existing data:
  `brand-sales` snapshots for real Order Line Items + Product Catalog sales,
  saved `asin-performance-v1` Ads history for same-ASIN ad spend, and saved
  `fba-plan` snapshots for FBA Inventory Health values. This is materially
  faster than the earlier per-account browser loop and avoids repeated token
  use.
- The page now has the three country-level operating views requested from the
  Sellerboard examples: **Daily Snapshot** (sales, last-year comparable
  sales, ad spend, TACoS, FBA inventory, inventory cover, units), **Monthly
  Snapshot** (six months, current-month actual and run rate), and **7-Day
  Performance** (daily sales, units, ad spend, TACoS, plus units by country).
  Sales are never summed across currencies: each marketplace/currency remains
  a separate row and `All Markets` totals are per currency only.
- **TACoS definition:** saved same-ASIN ad spend divided by the selected
  brand's sales for the same date range. This is a brand-scoped ratio, unlike
  the old account-wide Ads denominator. **Inventory cover:** latest saved FBA
  available units divided by the selected month-to-date unit daily rate,
  expressed in 30-day months.
- Missing upstream history is deliberately shown as `-`, never as zero. Ads
  need the scheduled `asin-performance-v1` history to have seeded for that
  account; FBA inventory needs at least one saved FBA Shipment Plan snapshot.
  A brand also must have a saved Account View (`brand-sales`) snapshot before
  it can be mapped into the Brand directory. This applies particularly to a
  newly connected secondary DataDoe account: refresh that specific Account
  View once, then refresh its FBA Shipment Plan once if FBA metrics are needed.
- The Brand View refresh is an aggregation of already-saved shared data, not a
  live DataDoe refresh. This is intentional. Refresh the individual Account
  View/FBA Plan or allow the existing Ads scheduler to update source snapshots
  first; then use Brand View refresh to publish the fast shared brand-country
  report to all permitted users.
- Code is committed as **`0de1494`** (`Upgrade shared brand country
  snapshots`) and deployed from the repository root as Vercel deployment
  **`upriver-dashboard-cft9coupo-laxmikant1604s-projects.vercel.app`**, which
  is aliased to the stable production URL https://upriverdashboard.vercel.app.
  Production HTML references bundle `index-JE4809lq.js`, the bundle generated
  by that deployment. `npm run verify` passed (53 assertions) and the full
  Vite build completed before release; Node syntax checking also passed for
  `api/datadoe.js`.

1. Read this file end to end.
2. Verify the live site works by hard-refreshing the Vercel deployment.
3. If it errors, read the on-screen error message; the app surfaces DataDoe errors verbatim.
4. Make code changes under `sales-dashboard-live/`, then commit and push.
5. Vercel should auto-deploy from the main branch.
6. If `git push origin main` returns 403 for `aibylk16`, reject the stale cached GitHub credential for `https://github.com` so Git Credential Manager can authenticate as `LaxmiKant1604`, then push again.
7. Update this file whenever a task is completed, new context is learned, or an important decision is made.
