# Handoff — Website report repair (rounds 1+2) + scheduler permanent repair (DEPLOYED) + open gates

**Branch:** `main`   **HEAD:** round-2 commit (below)   **origin/main:** push PENDING for round 2
**Latest deploy:** Vercel Production **Ready** at `45f14e8` (round 1, Codex-confirmed). Round 2 deploys on push.
**Date:** 2026-09-09
**DataDoe this session:** 0 exports / 0 tokens   **api/*.js:** 12 (unchanged)

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
