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

## 4c. Cross-bucket-coherent finalize (`finalizeBucket` token/reservation coherence)

`finalizeBucket` reconciles the Catalog source job's `create_export_count` with the operation-wide reservation.
Because the one org-scoped Catalog export is **shared** by both buckets against **one** reservation, a bucket
finalizes in either role:

- `create_export_count = 1` → THIS bucket attempted the create: the **exact** created reservation (status
  `created`, matching hash, `tokens_spent = 2`) whose **export id is the one this job created/adopted**. In the
  priority path (which force-plans Catalog) the second bucket also shows `= 1` but **adopts the same export id**,
  so only one real DataDoe create / two tokens ever occur across the operation;
- `create_export_count = 0` → zero tokens here, but a proven durable cache pointer (`cache_object_path`) is
  **required**, and the reservation is **either** absent (true warm-cache-first, zero tokens, no reservation)
  **or** the **other bucket's** exact created reservation (same hash/export/`tokens_spent = 2`);
- every other combination (missing/`reserved`-only reservation, hash mismatch, blank export, wrong tokens,
  export id ≠ the reservation's export, impossible count) is refused.

Proven by the real two-bucket **F13** (cold US creates once, warm Non-US adopts the same org export, **both**
finalize, total creates = 1 / tokens = 2) plus the deterministic `P4b2`/`P4b4` warm-first + cross-bucket accepts
and the full `P4c` refuse matrix.

## 5. Complete-surface publish + shared preflight + exact read-back (`preflightAccount` / `publishAccount`)

The **real** publisher gains a read-only **preflight** mode (`publishSchedulerV2Snapshot({ preflight: true })`,
exposed as `buildSchedulerV2Publisher().preflight`): it runs the SAME collaborators + gates + validations up to
(not including) the CAS and returns `ready` with the exact live identity. `preflightAccount(accountId)` runs it
for all three keys. The runner verifies the preflight **shape strictly** — the account id echoes the request,
and the results are **exactly** the frozen three keys (unique, no missing/extra/duplicate), each `ready` with a
nonblank live identity — and proves **every** account × three keys are publishable **before the first live
write**, so a malformed or non-ready preflight causes **zero** partial publish, with **no** gate logic
duplicated in the CLI.

`publishAccount` publishes `daily-reporting`, `brand-sales`, `brand-inventory` — **brand-sales before
brand-inventory** — through the real publisher's four durable gates + validated-job + terminal-cycle +
exact-shadow-identity + payload-contract + CAS write, carrying each result's exact live identity
(`liveReportKey` + `paramsHash`). The runner then reads each live snapshot back by that **exact** identity
(`buildLiveReadback`). Identity is proven from the **row columns** `report_key` + `account_id` (the published
live params carry **no** `accountId`); the stored params carry the exact live version + contract-derived live
params and **re-derive** `paramsHash` (a mutated-after-save row fails provenance); nonblank refresh, storage-first
payload, and the real frontend payload contract. This module never enables a control or an approval, never sets
`all_primary`, and never enables the scheduler.

## 6. Prepared publication control package (`buildPriorityControlPackage` + `runControlPackageTransaction`)

`lib/server/sync/source-priority-control-package.js` computes the EXACT global target control state (builder) and
runs it as **one guarded, advisory-locked transaction** (`runControlPackageTransaction`, all gate logic here —
never duplicated in the CLI); `scripts/release/priority-control-package.mjs` drives it through a pg-backed store
(dry-run default; `--apply` / `--rollback`).

- **Apply** actively **produces exactly** the target — enabling the rollout/dispatch/promoted/approval rows and
  **reconciling away** any pre-existing extra — then asserts the **complete global sets** before COMMIT (never
  filtering unexpected rows away): the enabled rollout set = exactly the primary accounts; enabled dispatch =
  exactly `daily-reporting` + `brand-sales` (every other controlled report paused); enabled promoted = exactly
  `brand-inventory`; approved = exactly the three keys × every account; `all_primary` false; no cron.
- **Rollback** is a documented **safe-close** (not a rediscovered blind restoration): it disables **every**
  rollout row, pauses **all 13** controlled settings, disables **every** promoted control, and revokes **every**
  approval — complete and correct regardless of what discovery returns at rollback time — and verifies that
  end state before COMMIT.
- Any PRE/POST mismatch rolls the **whole** transaction back (no partial write survives). `P12` drives the
  transaction through a fake store (extra rollout/approval reconciled or rolled back, changed discovery between
  apply/rollback, PRE violations, rollback completeness, transaction rollback on every mismatch).

## Regressions

- `scripts/source-priority-dashboards.test.js` (P1–P12, 59 assertions): the operation-wide durable Catalog guard
  (hash-mismatch / commit-unknown / concurrency / adoption); the allowlist + publish order; the 30-account plan
  (zero OLI/FBA jobs, one Catalog job/bucket); the composition wiring (build-time priority) + `finalizeBucket`
  cold/warm-first/**cross-bucket**/retry accept + the full refuse matrix incl. every token/reservation ambiguity;
  the Brand View inventory contract; the **real** publisher's `not-successful`→`published` and the **shared
  preflight**'s `not-successful`→`ready` (zero writes on any non-ready pair); `buildAccountBrandSlice`; the
  mocked-real reservation wrappers (strict validation); the strict runner (exits nonzero on every non-success,
  warm-cache zero tokens, missing live identity, **strict preflight shape** P9m/n/o); the exact-identity
  `buildLiveReadback` (row report/account echoes, no fabricated `accountId`, omitted/wrong hash + provenance +
  dangling + contract fail, exact passes); the control-package builder (P11); and the guarded control
  **transaction** (P12: exact-global apply, safe-close rollback, fail-closed rollback on every mismatch).
- `scripts/source-production-hardening.test.js` (F11a–f, F12a–d, F13; 118 assertions): the real-runtime derive
  off durable OLI + Catalog; missing FBA → unavailable; fail-closed on missing provenance; ordinary callers
  cannot activate priority mode; the durable reservation with the real runtime + worker (cold/warm/cross-bucket/
  midnight); and **F13** — a real two-bucket derive + the cross-bucket-coherent finalize (cold US creates once,
  warm Non-US adopts the same export, both finalize, total creates = 1 / tokens = 2).
- `scripts/schema-contract-mutation.test.js` (Migration-9 contract + 14 weakening regressions; 50 assertions);
  `scripts/release/release-selftest.mjs` (stage-8 baseline + the protected-drift reconciliation classifier; 184).

`npm run verify` (57 steps / 37 suites, incl. `build:check`) is green. Migration-9 SQL + SHA are **unchanged**
this round (`daf1997a…`).

## Operator run (deferred — do NOT run in production before Codex sign-off)

Approved production order (each step gates the next; STOP on any anomaly):

1. **Stage-8 read-only reconciliation:** `node scripts/release/stage8-reconcile.mjs`. It captures the eight
   protected digests and classifies every difference from the manifest pins. **Review any drift** — record
   intentional-state evidence — before touching a pin.
2. **Stage-8 re-anchor at the final reviewed HEAD:** after the review, update the pins/invariants (code/tests
   commit, then docs), then `node scripts/release/re-anchor-stage8.mjs` to regenerate the stage-8 baseline at the
   **final** HEAD.
3. **`ro-prod-check.mjs 8`** (read-only): confirm the stage-8 protected state matches.
4. **Guarded Migration 9 apply:** verify the `created_coherent` canon against the live catalog, then
   `apply-one-migration.mjs 20260825_priority_catalog_reservation.sql`.
5. **`ro-prod-check.mjs 9`** (read-only): confirm the applied migration matches.
6. **Push once**, then **verify the exact Vercel deployment** is the pushed HEAD.
7. **Confirm ≥2 DataDoe tokens** (read-only).
8. **Controls:** review `node scripts/release/priority-control-package.mjs` (dry-run), then `--apply` (one
   guarded transaction: exact-global apply + PRE/POST assertions).
9. **Run the priority release** `node scripts/release/priority-dashboards-release.mjs` (exits nonzero on any
   non-success): read-only reconciliation → derive US then Non-US → re-prove ≤2 tokens (warm-cache-first spends
   zero) → `finalizeBucket` each bucket → **shared publisher preflight (strict shape) for every account × 3** →
   publish (brand-sales before brand-inventory) → **exact-identity** live read-back.
10. **Verify all exact live identities + API + frontend** (`GET /api/datadoe?action=daily|brand-sales|
    brand-inventory`).
11. **Safe-close the controls** (`priority-control-package.mjs --rollback`) and **confirm no cron**. Keep every
    other report paused; keep `all_primary=false`. **The scheduler is a separate, later gate** — STOP for Codex
    review before any scheduler enablement.
