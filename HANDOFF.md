# Handoff — Website report repair (rounds 1-4) + all-region scheduler repair (PARTIAL) + open gates

**Branch:** `main`   **HEAD:** scheduler per-account publication (partial) commit `f3a7d9d` (prior scheduler-repair
`e4e3ff2`/`7d99d00`; report rounds 1-4 at `8285b7a`).
**f3a7d9d + e4e3ff2 are committed locally on `main`, NOT yet pushed** — the scheduler effect lands only on the NEXT
natural cron off origin/main, so they need a push (normal path, no dispatch) to take effect. Awaiting go-ahead to push.
**Latest deploy:** Vercel Production **Ready** at `c0d92cd` (round 3, Codex-confirmed); round 4 (`8285b7a`) deployed.
**Date:** 2026-09-09
**DataDoe this session:** 0 exports / 0 tokens   **api/*.js:** 12 (unchanged)   **verify:** 186/186 (162 suites).

## → CODEX HANDOFF (what to do next — Upriver owns GitHub/Cloudflare/migrations/natural-run observation)

Round 4 is pushed (`8285b7a`) and deploys on this push. **Everything below is observe/approve only — do NOT raise
spending limits, manually dispatch a scheduler/DataDoe/workflow run, or apply a migration without explicit approval.**

1. **Confirm the Vercel Production deploy** of `8285b7a` is Ready (rounds 1-3 were Codex-confirmed the same way).
2. **Natural-run acceptance (do NOT dispatch)** — observe the next natural india (03:00 UTC) / europe-au (08:30) /
   us-ca (16:30) cycles and confirm on a real page: (a) a lagging **available** Brand View LKG keeps showing with its
   real (older) inventory date and is NOT shadowed by the same-cycle unavailable placeholder republish; (b) a
   same-window Ads correction/delete flips `content_rev` and rebuilds Brand View; (c) the Daily ads band shows the
   recorded-extent wording and unrecorded covered days as unavailable (—), never a measured zero.
3. **Migration `20260923_ads_content_rev.sql` — STILL approval-gated.** The Ads content-rev fold is fail-soft/inert
   until it lands. Decide on the revision design, then (only if approved) apply via
   `MIGRATE_ONLY=20260923_ads_content_rev.sql npm run db:migrate`. No other migration is touched.
4. **All-region scheduler repair — PARTIAL, code-complete + tested at `e4e3ff2`** (deliverable:
   `sales-dashboard-live/scratchpad/ALL-REGION-SCHEDULER-REPAIR-DELIVERABLE-20260909.md`; evidence matrix:
   `SCHEDULER-INVESTIGATION-20260909.md`). Fixed + tested (code verification only, NOT production acceptance):
   - **LH v3 pricing coherence:** estimate + first gate + frozen binding now use ONE real-registry price (listings
     PREMIUM 5 / listings-raw STANDARD 2). Authorized ceilings UNCHANGED. Honest awaiting-budget: **US-CA 11 accts =
     21 > 16**, **Europe-AU 30 accts = 42 > 28** (zero creates); India 8 = 14 ≤ 16 proceeds. Proven through the FULL
     live composition (a 21-token FROZEN plan is refused under 16 EVEN under full exact reuse — the binding gate binds
     the frozen reservation ceiling, which never shrinks with reuse). **Do NOT raise a limit to fit — reviewed PR only.**
   - **OLI readiness + authorized-wave isolation:** discovery stays FULL (frozen-owner check preserved); the FRESH plan
     is the POSITIVELY-authorized eligible set (`freshPlanAccountIds` allowlist), not discovery-minus-exclusions, so an
     unready seller never poisons a batch and a new/un-gated account (or a bootstrap account outside the approved wave)
     cannot bypass onboarding. A continuation reuses frozen membership/budget verbatim.
   - **Per-account DASHBOARD publication — NOW IMPLEMENTED (`f3a7d9d`), not just designed.** Root cause: saving OLI
     history ≠ dashboard publication; `oli-refresh-d1` exited 1 on a partial → the whole region's readiness/controls/
     publish were skipped. Fix: three-way outcome (`classifyOliPublicationOutcome`: complete / partial-publishable /
     fatal) emitted as workflow outputs; on a PARTIAL the workflow publishes EXACTLY the healthy OLI-eligible subset
     (`priority-dashboards-release --eligible-accounts`) into a dedicated cycle bucket (`priority-partial-<region>-
     <hash>`, reusing the bootstrap seam), leaving deferred accounts' dated LKG untouched; COMPLETE path byte-identical;
     fatal/all-deferred exits nonzero (never false-green). NO migration. END-TO-END regression through the REAL
     publisher (PP1a–e) + workflow/source guards (D5/D6) + classifier (C4). Two adversarial-review rounds (2 HIGH
     defects found + fixed). OBSERVE a natural PARTIAL cycle (never dispatch): healthy subset fresh D-1, deferred keep
     LKG, run honestly reported PARTIAL. The remaining OPTIONAL durable per-account outcome ledger (a migration) is
     still deferred; eligibility remains fully inferable without it.
   - **Observe (do NOT dispatch)** the next natural india/europe-au/us-ca cycles: OLI excludes unready sellers (logged
     "onboarding gate … excluded N"), NOT a DATADOE_INITIAL_LOAD_INCOMPLETE batch rejection; LH v3 logged
     estimatedTokens == frozen maxTokens; no region spends beyond its UNCHANGED authorization. NOT yet reproduced:
     REELLEO Express IT (Europe FBA 21/22) needs the run's evidence; US-CA not-drained predates `583923d`.

## Round 4 (4 reproduced defects on `c0d92cd` + 3 Codex follow-up findings) — code-complete, `npm run verify` 184/184 (commit `8285b7a`)

Two adversarial-review rounds drove revisions of the first round-4 attempt (Codex rejected: the ads "2-day settled"
assumption, "non-empty = authoritative replacement", and the "latest-12" inventory cutoff); a final focused review of
the two remaining confirmed fixes returned **zero** findings. Net fixes:
- **(1) Cycle-bound inventory authorization** decoupled from the latest displayed snapshot: authorize on the EXACT
  current-cycle publication (`getReportSnapshot` at `paramsHashFor({to: cycleAsOf})`), so a lagging rebuild can't
  invalidate a later fresh update in the same cycle; revoked/missing-cycle fail closed.
- **(2) Serve SELECTS the authoritative available compact** (`selectAuthoritativeInventorySnapshot`) so a same-cycle
  unavailable placeholder republish can't shadow a lagging available LKG. The LKG is found WITHOUT a recent-N cutoff
  via a direct payload query (`payload->>inventoryAvailable=eq.true`) + the newest overall — works for any writer, no
  marker. Round-3 cycle-fold stays removed (pure content idempotency; real older date kept). Writer + serve select
  identically; the dependency fingerprint keys on the SELECTED compact.
- **(3) Empty-Ads revision + deletion completeness:** a successfully-read empty window gets a stable non-null
  `EMPTY_ADS_CONTENT_REV` (distinct from a thrown read = preserve previous), so nonempty→empty invalidates dependents;
  the aggregated clean-replace runs only on a proven-complete window (fetchAllPages complete-by-construction +
  validateExportPage fail-closed) and now CHECKS the per-account delete ack (a failed delete excludes the account —
  no double-count, no data loss). (Deletion path dormant: asin-only, create-retired; campaign is upsert-only.)
- **(4) Honest Ads completeness:** `resolveDailyAdsAvailability` makes NO completeness claim without explicit
  evidence — no reporting-lag constant, no "later metric proves earlier days", invariant to `requestedTo`. It reports
  the factual recorded-data extent; a covered day with no recorded row is unavailable, never a measured zero.

**Migration `20260923` unchanged (approval-gated). No paid exports, no dispatch, no limit changes. Detail:**
`PROJECT_MEMORY.md` (2026-09-09 round-4 entry) + `sales-dashboard-live/scratchpad/SCHEDULER-INVESTIGATION-20260909.md`.

---
## Round 3 (5 deeper integration defects on `842f9ca`) — code-complete, `npm run verify` 184/184 (commit `7c8afc3`)

Closes gaps the round-3 adversarial review found deeper in the sync -> store -> fingerprint -> materializer -> serve
chain (the review confirmed 2 findings — one HIGH I introduced — both fixed before commit): **(1)** an equal-timestamp
and a LAGGING inventoryAvailable:false->true now WRITE through the real `materializeSnapshot` via a CONTENT fingerprint

## Round 3 (5 deeper integration defects on `842f9ca`) — code-complete, `npm run verify` 184/184 (commit `7c8afc3`)

Closes gaps the round-3 adversarial review found deeper in the sync -> store -> fingerprint -> materializer -> serve
chain (the review confirmed 2 findings — one HIGH I introduced — both fixed before commit): **(1)** an equal-timestamp
and a LAGGING inventoryAvailable:false->true now WRITE through the real `materializeSnapshot` via a CONTENT fingerprint
(`compactInventoryContentFingerprint`), with the CYCLE folded in for a lagging compact so the fresh unavailable
placeholder can't shadow it across cycles; a same-content/same-cycle replay stays a zero-write no-op. **(2)** rebuild
authorization is CYCLE-BOUND (`live.params.to === inventory_asof`, threaded via `--inventory-as-of`), not mere row
existence — an old-cycle row / revoked account / missing asof all fail closed. **(3)** the Ads content revision now
describes COMMITTED durable data (`committedContentRev` re-reads the store over a canonical 60-day window —
window-independent + delete-aware; a THROWN read preserves the previous rev, never a spurious flip). **(4)** the Ads
notice distinguishes verified delay vs verified zero vs UNKNOWN (`verifiedThrough` + `provisionalState:unknown-unverified`);
delay is no longer inferred from latestMetricDate alone. **(5)** Listing Health v3 runs when FBA publishes ZERO accounts
— the v3 job gate dropped `fba_published` and now keys on `needs.run.result=='success'` (FBA is ordering-only), so
Listings/OLI publish and inventory stays unavailable per-account.

**Next: push `main` (Vercel deploy) + keep migration `20260923_ads_content_rev.sql` approval-gated until the revision
design is reviewed** (the content-rev fold is inert until it lands). Then observe natural regional runs (do NOT
dispatch). Detail: `PROJECT_MEMORY.md` (2026-09-09 round-3 entry) +
`sales-dashboard-live/scratchpad/REPAIR-STATUS-MATRIX-20260909.md` (recalculated paid-source plan — NOT a flat 34/day).

---
## Round 2 (5 integration follow-ups) — code-complete, `npm run verify` 184/184

Fixes real gaps in round 1 + completes v3: **(1)** brand-inventory rebuild was INERT in prod (gated on a
safe-closed control) -> per-account authorization off the priority run's already-published live compact; **(2)**
same-window Ads corrections now flip the fingerprint via a durable `ads_sync_state.content_rev` (migration
`20260923` PENDING APPROVAL; code fail-soft); **(3)** Daily UI shows a verified-vs-pending ads-coverage band;
**(4)** Listing Health v3 optional-inventory END-TO-END (per-account adoptability, reuse-only complete-as-unavailable,
gate `fba_complete`->`fba_published`); **(5)** `sales` stays manual (order-count not zero-export-reproducible) +
a quantified paid-source approval plan. The adversarial review caught + I fixed a HIGH bug: `fba_published` was a
numeric count so the `== 'true'` gate was unsatisfiable (v3 would never run) — now emits a boolean.

**Next: push `main` (Vercel deploy) + present migration `20260923_ads_content_rev.sql` for approval.** Then observe
natural regional runs (do NOT dispatch). Detail: `PROJECT_MEMORY.md` (2026-09-09 round-2 entry) +
`sales-dashboard-live/scratchpad/REPAIR-STATUS-MATRIX-20260909.md`.

---
## Round 1 (COMMITTED `0cffb2e`, DEPLOYED `45f14e8`)

## Latest: website-wide report repair (commit `0cffb2e`) — code-complete, NOT yet pushed/deployed

Four confirmed report-population defects fixed (zero-export, no migration, api/*.js=12), from the Codex
`scratchpad/CLAUDE-WEBSITE-REPORT-REPAIR-PROMPT.md` + audit:
- **B** dependency-fingerprint freshness (writer idempotency + serve staleness key off the complete dependency set,
  not a single brand-sales timestamp; TOCTOU-safe; the repro is inverted into a regression).
- **A** the compact `brand-inventory` is REBUILT from the fresh fba-plan in the materialize-inventory job (same-day
  D-1 inventory reaches Brand View; the 34 unavailable compacts flip to available where FBA is fresh).
- **C** typed Ads provisional-tail marker (honest "metrics through X, later pending" — no invented zeros).
- **D** Needs Restock KPI + Remark footer show "—" (not 0 / OK) when inventory is unavailable.
- Section 3/4: Campaign Ads declared in the scheduled-family guard; Listing Health v3 inventory made OPTIONAL at the
  derive+registry level (region-wide prerequisite removal + v1 paid-source scheduling = separate approval items).

`npm run verify` = **183/183 across 159 suites** (incl build:check); `git diff --check` clean. Full root causes +
per-report/per-region status + approval plan: `PROJECT_MEMORY.md` (2026-09-09 entry) +
`sales-dashboard-live/scratchpad/REPAIR-STATUS-MATRIX-20260909.md`.

**Next step for delivery:** push `main` (triggers the Vercel production deploy) — the repair touches the live
brand-view serve (read-only, fail-soft fingerprint reads) + the scheduler materializer (converges on the next
natural cycle). Then observe the natural regional cycles for prod acceptance (do NOT dispatch).

---
## Earlier this session: Scheduler permanent repair (DEPLOYED, `583923d`)

> The full detail for every item below lives in `PROJECT_MEMORY.md` (canonical running
> log — read it at session start). This file is the short "where we stopped" pointer.

---

## Working-tree state

Clean of code changes. Only untracked scratch/local artifacts remain (not part of any task):

```
.worktrees/                                              (local worktrees)
scratchpad/  sales-dashboard-live/scratchpad/            (scratch)
sales-dashboard-live/scripts/release/.release-baseline*.json   (release baselines)
```

There is **no interrupted coding task** — nothing to resume in code.

---

## What was completed and shipped (commit `583923d`, DEPLOYED Ready)

**Scheduler PERMANENT REPAIR** — fixes the all-region "not-drained" priority-derive
failure (proven root cause: the OLI step ran OLI-only, pausing Catalog, so the priority
Catalog derive became a case-(c) deferred continuation and no family executed).

- **P0-A** — one complete daily-cycle plan before the first paid create: `executeSourceKeys`
  freezes every planned family's budget but creates/drains only the listed ones;
  `oli-refresh-d1` freezes `[OLI, CATALOG]` and executes OLI only, so the priority step
  drains the frozen Catalog as a case-(a) continuation. `onlySourceKey` path byte-identical.
- **P0-B** — fresh-on-active (an empty freshly-opened head takes the fresh plan, not a
  deferral) + legacy OLI-only running-cycle recovery (finalize + idempotent superseding).
- **P0-C** — continuation ceiling uses the durable frozen tranche budget verbatim
  (no false `TOKEN_CEILING_EXCEEDED` from live recompute).
- **P1** — FBA completeness is a real contract: `fba_complete` job output; v3 gates on it,
  not on job `result == success`; a partial FBA region stays visibly partial.
- **P0-D** — concurrency-safe onboarding discovery reconcile: forward-only status resolver +
  additive `SECURITY DEFINER reconcile_account_onboarding_discovery(jsonb)` RPC. Code
  fail-soft to the old merge-upsert when the RPC is absent.
- **Release guard** — `scheduled-family-registry.js` + test declares/validates every
  automatic family's contract against `scheduler-v2.yml` and the source registry.

**Migration 20260922 APPLIED to prod (2026-09-09, approved, MIGRATE_ONLY).** Ledger 50→51
(+1 exactly). RPC verified `SECURITY DEFINER`, EXECUTE = postgres + service_role only.
Rolled-back functional proof against the live RPC: **10/10** (zero net DB change). The
deployed code now takes the atomic RPC path.

**Gates at the shipped commit:** `npm run verify` = **180/180 across 156 suites** (incl
`build:check`); `git diff --check` clean; api/*.js = 12; no formulas / D-1 policy / UI
metrics / permissions / isolation / 5-seller batching / LKG / token prices / schedulers /
cron times changed. *(This is the logged result at `583923d`; code is unchanged since, so
it still holds. Re-run `npm run verify` from `sales-dashboard-live/` for a fresh confirm.)*

---

## OPEN acceptance gates — observation only, do NOT dispatch

These are the reason the work is "shipped but not fully accepted." None require code.
**Do not manually trigger any scheduler / DataDoe / workflow run** (per standing directive;
Codex owns GitHub/Cloudflare). Each resolves by observing the *natural* run.

1. **Natural regional cycles on `583923d`-or-descendant** — india (03:00 UTC),
   europe-au (08:30), us-ca (16:30): confirm each drains the priority Catalog derive and
   no longer reports `not-drained`.
2. **Natural account-onboarding discovery run** — confirm it succeeds via the atomic RPC
   with no `account_onboarding_claim_coherent` violation (migration 20260922 now live).
3. **FBA bulk lead-time note — authenticated BROWSER flow** (migration 20260920, already
   applied; DB persistence proven 10/10). Still open: the live UI
   download → edit → preview → import → reload → persistence flow, incl. account switch
   during a pending request. No authenticated session was available to run it.
4. Several recent features (onboarding + FBA D-1, readiness batch-poisoning heal, release
   env import-ordering fix, FBA account-level column visibility) each carry a
   "PROD ACCEPTANCE pending a natural regional run" note — same rule: observe, don't dispatch.

---

## If you pick up new work

- Keep `api/*.js` at **12** (Vercel Hobby cap — adding one breaks the deploy).
- `db:migrate` is a clean no-op (ledger reconciled); apply new migrations only with
  explicit approval via `MIGRATE_ONLY=<file> npm run db:migrate`.
- Verify live DataDoe balance before any create; the repo default is zero-export.
