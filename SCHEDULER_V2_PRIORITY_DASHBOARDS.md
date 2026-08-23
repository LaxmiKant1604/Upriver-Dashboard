# Scheduler v2 — Daily Reporting + Brand View "priority release"

Offline-implemented, operator-run path to bring **only** Daily Reporting and Brand View live for the covered
accounts by deriving them from the **already-proven durable OLI history** + the organization **Catalog**, at a
hard ceiling of **2 tokens** (one Catalog export) and **zero** OLI / Ads / FBA / other-report exports. It
requires no full bucket drain and enables no scheduler.

User-facing scope is **two surfaces** (Daily Reporting + Brand View). Brand View is assembled from **two** live
snapshot keys — `brand-sales` (the sales + ASIN→brand evidence `buildAccountBrandSlice` reads) and
`brand-inventory` (the compact inventory) — so the frozen priority publication set is exactly:

```
["daily-reporting", "brand-sales", "brand-inventory"]
```

This authorizes no other dashboard.

## Why this exists

A normal bucket sync derives the durable dashboards only after `globalDrained` — every planned source job must
terminalize: the trailing OLI rolling-refresh window, a per-account FBA export, Ads, and the Catalog. A read-only
drain-cost rehearsal on the live tree (2026-08-23) measured that a full drain for the 30 primary accounts needs
~37 DataDoe creates (≈ 6 OLI rolling-refresh + 1 org Catalog + 30 FBA) ≈ 74–185 tokens, vs. the authorized 2.
The durable OLI evidence for all 30 accounts is already complete and gapless; the only thing missing to publish
the dashboards is a derive, and a derive should not pay for a full refresh. This path derives from what is
already durable.

## 1. Trusted, build-time priority binding

Priority mode is bound at **build time** on the runtime, never a `run()` argument an ordinary caller can flip
(mirrors the `recoverFailedDownloads` trusted-flag precedent):

- `buildBucketSourceSyncRuntime({ priorityMode: true })` — when set, every `run()` on that runtime is a priority
  derive: pause every non-catalog source (zero OLI/Ads/FBA/other exports, structurally), force-plan the Catalog
  family (`forceCatalogRefresh`) so a catalog-only cycle drains and the durable-evidence derive/save runs even
  when the Catalog snapshot is fresh, and represent missing Ads (daily runs sales-only) and missing FBA
  (brand-inventory → `inventoryAvailable:false`) as **unavailable**. `run()` has no `priority` argument.
- HTTP routes, card actions, and the scheduler build the runtime with no arguments and get `priorityMode=false`;
  only the reviewed release composition sets it true. Non-priority behaviour is byte-identical.

## 2. The trusted release composition (`lib/server/sync/source-priority-dashboards.js`)

`buildPriorityDashboardsRelease({ … })` freezes the report keys, the collaborators (the priority runtime, the
real `buildSchedulerV2Publisher`, the store, the durable reservation), the account-scope check, and the publish
order. Its public surface takes only identifier strings; a caller cannot inject or widen report keys, readiness,
controls, approvals, scope, or publish behaviour, and an unknown report key can never reach the publisher
(`assertPriorityPublishReportKey` + the publisher's own `unknown-report`/`code-locked` gates). It exposes exactly:

- `deriveBucket(bucket)` — the priority derive (never finalizes a cycle);
- `verifyAndFinalize({ cycleId, expectedAccountIds })` — the reviewed cycle-close (§3);
- `publishAccount(accountId)` — the complete-surface publish (§4).

`PRIORITY_DASHBOARDS` is the frozen scope: the 3 report keys, `publishOrder` (brand-sales before
brand-inventory), `catalogSourceKey`, `buckets`, `maxCatalogCreates=1`, `maxTokens=2`, and the `operationKey` the
durable reservation is keyed to.

## 3. Reviewed cycle-close + no caller-forgeable scope (`deriveBucket` / `finalizeBucket`)

Both operations take **only the bucket identifier** — a caller cannot inject a preflight, an account list,
collaborators, dates, readiness, or scope. `deriveBucket(bucket)` creates its own deadline and runs its own
production preflight. The priority **source** runtime still never finalizes the shared cycle.

`finalizeBucket(bucket)` **independently reconstructs and re-proves** the durable scope (a restart re-proves from
durable state, never an in-memory attestation), then calls the guarded `finalize_sync_cycle` RPC:

- expected accounts = **fresh, primary-only discovery** for the bucket (not caller-supplied);
- the **cycle row itself**: exact bucket, `running` status, reviewed `manual` trigger;
- source jobs: **exactly one** `product-catalog` job with the **reserved** canonical hash, `succeeded`, and
  **organization** scope (its owner is `__organization`);
- report jobs: **exactly** accounts × 3 (`daily-reporting` / `brand-sales` / `brand-inventory`), each
  `derive_status`/`save_status` = succeeded + `validated=true` + nonblank `snapshot_params_hash`, with **no
  duplicate** natural identities and no unrelated/unexpected account;
- refuses unrelated / open / malformed / mis-scoped work;
- accepts **only** a strict `finalized` / `already-terminal` acknowledgement with a terminal cycle.

Because the publisher's source-of-truth gate requires a terminal cycle (`cycle_status ∈ {succeeded, partial}`),
the real publisher returns `not-successful` for all three reports **before** finalization and publishes only
**after** the genuine terminal cycle exists.

## 4. The durable OPERATION-WIDE one-Catalog-export / two-token ceiling

The ceiling is **durable and operation-wide**, not a process-local counter (which could not survive a restart or
two concurrent processes) and not per-hash (which a changed hash could slip past). The reservation identity is
the **operation alone** (`operation_key` is the primary key), so one operation authorizes at most ONE Catalog
create ever. The first canonical Catalog request hash is stored as **immutable evidence**; a **different** hash
for the same operation (e.g. midnight / `asOf` date drift) is a typed **hash-mismatch** authorizing **zero**
creates. The Catalog is organization-scoped, so US and Non-US resolve the **same** hash and share the one row.

- New additive, **UNAPPLIED** migration `supabase/migrations/20260825_priority_catalog_reservation.sql`
  (Migration 9): the `source_priority_catalog_reservation` table (PK `operation_key`) +
  `reserve_priority_catalog_create` / `record_priority_catalog_export` SECURITY DEFINER RPCs (advisory-locked on
  the operation key, atomic; the RPCs never DELETE, never mutate the immutable hash, and only advance status
  `reserved`→`created`) + RLS + coherent admin-read ACL (authenticated SELECT reachable only via the admin-only
  policy; service_role SELECT). The supabase.js wrappers validate **every** acknowledgement strictly (exactly
  one plain object, a known disposition, the exact `operation_key` + `catalog_request_hash` echoes, and
  disposition-dependent fields) and fail closed before any POST; `makeDurableCatalogGuard` enforces the flow.
- Flow: the reservation **winner** performs the ONE create (2 tokens) then records its export id; a later attempt
  whose reservation already carries an export id **adopts** it (poll/download only, zero create/tokens); a
  reservation without a recorded export id (a create in flight / commit-unknown) is **AMBIGUOUS** and never falls
  back to a second create; a **hash-mismatch** is refused (no second create). Any OLI/Ads/FBA/other create
  throws. This holds across US + Non-US, retries, restarts, concurrency, commit-unknown, and date drift.

## 4b. Release registration (Migration 9) + the strict operator runner

- **Both** release contracts register Migration 9: `lib/server/sync/schema-contract.js` (System B, in
  `npm run verify`) — the table + RPC contract, **structural function-body proofs** (operation-wide one-create,
  immutable hash, hash-mismatch, record conflict, no reset/delete route), wrapper registration, and 14 mutation
  regressions; and `scripts/release/release-manifest.mjs` (System A) — the Migration 9 entry (frozen SHA-256
  `daf1997a173fbf9c9447a61883a32f8b129e9b666eb2e0d2ee3d4a78da045a7f`, advisory locks `[20260825, 1]`).
  `release-state.mjs` gains the stage-8 baseline trio + `runApply` dispatch; a **dedicated** `re-anchor-stage8.mjs`
  (hard-coded `ANCHOR=8`) governs ONLY Migration 9; `ro-prod-check.mjs` / `apply-one-migration.mjs` extend to
  stage 8; `release-selftest.mjs` gains a stage-8 block. (The `created_coherent` canon in System A is a
  best-effort pending live `bodyCanon(pg_get_constraintdef)` verification; ro-prod-check fails closed on a
  mismatch. Regenerate the `.release-baseline*.json` against production as the guarded release step.)
- **Strict operator runner** `lib/server/sync/source-priority-release-runner.js` (offline-tested) +
  `scripts/release/priority-dashboards-release.mjs` (deferred CLI): read-only reconciliation before any write;
  derive US then Non-US; re-prove the durable ≤2-token reservation; finalize each cycle via the corrected
  verifier; **read-prove all three publication gates for every account BEFORE the first live write** (no partial
  publish); publish the three reports (brand-sales before brand-inventory) accepting **only**
  `published`/`already-current`; read back the live identities and prove the frontend payload contract. It never
  applies a migration, enables the scheduler/cron, or touches unrelated reports, and **exits nonzero on every
  non-success disposition**.

## 5. Complete-surface publish (`publishAccount`)

Publishes `daily-reporting`, `brand-sales`, `brand-inventory` for one account — **brand-sales before
brand-inventory** so Brand View can never combine stale sales with fresh inventory. Every publish goes through the
real publisher's four durable gates (code readiness → exact report / promoted control → primary rollout →
audited per-(report, account) approval), then the validated-job + terminal-cycle + exact-shadow-identity +
payload-contract + CAS write. This module **never** enables a control or an approval, never sets `all_primary`,
and never enables the scheduler.

## Regressions

- `scripts/source-priority-dashboards.test.js` (P1–P7): the durable Catalog guard (catalog-only; at most one
  across buckets/retries/restart; commit-unknown and concurrency are AMBIGUOUS, never a second create; exact
  export-id adoption spends zero); the allowlist + publish order; the 30-account (8 US + 22 non-US) plan proving
  zero OLI/FBA jobs and one Catalog job per bucket; the composition wiring (build-time priority, no run-arg,
  catalog-only guard installed) + the `verifyAndFinalize` accept/refuse matrix; the Brand View inventory
  contract; the **real** publisher returning `not-successful` for all three before finalization and publishing
  all three after a terminal cycle; and the **real** `buildAccountBrandSlice` rendering fresh sales with
  inventory unavailable.
- `scripts/source-production-hardening.test.js` (F11a–f, F12a–c): the **real-runtime** derive off durable OLI +
  Catalog (30 accounts, one Catalog export, zero OLI/Ads/FBA); missing FBA → unavailable; force-catalog fixes
  the fresh-snapshot skip; fail-closed on missing provenance; ordinary callers cannot activate priority mode
  (the run-arg is inert); and the **durable reservation** with the real runtime + worker — cold US (one Catalog
  / two tokens / zero others), warm re-run (zero), and US + Non-US sharing ONE reservation both warm (cache
  reuse) and cold (export-id adoption).

`npm run verify` (57 steps / 37 suites, incl. `build:check`) is green.

## Operator run (deferred — do NOT run in production before Codex sign-off)

1. Apply Migration 9 through the **guarded release step** only: `ro-prod-check.mjs 8` → `re-anchor-stage8.mjs`
   (regenerate the stage-8 baseline) → `apply-one-migration.mjs 20260825_priority_catalog_reservation.sql`.
   Confirm ≥2 DataDoe tokens (read-only). Verify the `created_coherent` canon against the live catalog first.
2. Open the publisher gates for `daily-reporting` + `brand-sales` + `brand-inventory` only (durable report/
   promoted controls, account rollout, per-(report, account) approvals).
3. Run the strict runner `node scripts/release/priority-dashboards-release.mjs` (exits nonzero on any
   non-success): read-only reconciliation → derive US then Non-US → re-prove ≤2 tokens → `finalizeBucket` each
   bucket → read-prove all three gates for every account → publish (brand-sales before brand-inventory) →
   live-identity read-back with the frontend payload contract (`GET /api/datadoe?action=daily|brand-sales|
   brand-inventory`).
4. Close the temporary gates. Keep every other report paused; keep the scheduler disabled (`all_primary=false`,
   no cron). Stop for Codex review before any scheduler enablement.
