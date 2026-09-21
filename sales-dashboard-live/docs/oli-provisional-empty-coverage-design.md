# Design: provisional-empty OLI coverage, per-account finalization, partial-history publication

**Status: DESIGN ONLY — not implemented in this patch.** This is the architecture for permanently preventing the
flexii-class defect (a fabricated GBP 0 for historical periods) without the regressions an adversarial review found in
the naive persist-time readiness gate (which was implemented and reverted). It is written so the eventual prevent-
recurrence task starts from a vetted plan.

## The problem, precisely

A fresh-onboarding account can run its initial-history OLI backfill while DataDoe's historical load is still
incomplete. The historical slices return **HTTP 200 / row_count = 0** (the rows are not yet materialized, and this is
*not* the HTTP 400 the readiness-isolation catches). Today the persist path records those empty slices as **genuine
proven-empty `succeeded` coverage**, so the daily/brand derive folds a fabricated **GBP 0** for those months (flexii
UK, Jun–Aug 2026).

**No persist-time signal distinguishes "not yet loaded" from "genuine zero."** flexii exported while DataDoe reported
it *ready*; a genuinely new 2-week-old zero-sales seller looks identical (an empty deep-history window on an account
with a large all-source row count). So the distinction cannot be made from onboarding status, an age proxy, the
positive-data floor, or the all-source `datadoe_row_count` alone.

**Why a naive persist-gate cannot work** (the reverted attempt): deferring the empty ack leaves a leading coverage
gap; the derive's **gapless-coverage-from-2025-01-01** contract (`resolveEffectivePublishAsOf` blocks on a leading
gap) then prevents the account from grading to `ready`; the gate that required `ready` therefore never unlocks —
a permanent onboarding **deadlock** plus a paid empty re-export every cycle. And a `MISSING` lineage emits no report
jobs, so the all-or-nothing `finalizeBucket` **stalls the whole region** on one account.

## Design principles

1. **Never fabricate a zero** — an unconfirmed empty window must not read as genuine zero.
2. **Never deadlock onboarding** — the empty→proven transition must not depend on a state that itself depends on the
   coverage being acked.
3. **Never stall a region** — one account's unconfirmed coverage must not block others' publication.
4. **Self-heal** — the truth (real data, or a genuine zero) must land automatically once DataDoe finishes loading.

## Three coordinated changes

### A. Provisional-empty coverage (a coverage lifecycle, not a binary)

Give an empty window a lifecycle instead of an immediate `succeeded`:

- A row_count = 0 initial-history slice is recorded as **`provisional-empty`** (carrying the export's `request_hash`
  + `observed_at` + a `confirm_count`), **not** `succeeded`. This preserves lineage and marks the window "attempted"
  (so it is not blindly re-exported every cycle) **without asserting a genuine zero**. The derive treats
  `provisional-empty` as **not proven** → the client renders it **Unavailable** (the display layer this patch ships),
  never GBP 0.
- Promote `provisional-empty` → **`final-empty`** (a proven genuine zero) **only** on a source-backed completeness
  signal: **repeated confirmation** — the same window returns empty across ≥ N distinct daily cycles spanning at least
  the DataDoe initial-load horizon (flexii empirically took **> 1 week**; make it a configurable horizon, e.g.
  10–14 days) — corroborated where possible by **load stability** (DataDoe's reported per-account row extent stops
  growing across cycles and reconciles to the durable captured extent). If any confirmation cycle returns rows, the
  window becomes ordinary `succeeded` with real data — the false-empty never finalized.
- **Schema**: add the `provisional-empty` status (+ `observed_at`, `confirm_count`) to `source_coverage`. This is the
  "provisional-empty coverage" the owner named; it needs a gated, additive migration. `getSourceCoverageWindows`
  (which today filters `status = succeeded`) counts only `succeeded` + `final-empty` as proven.

### B. Per-account finalization (partial cycle, no region stall)

`finalizeBucket` today requires `seen == every discovered account x 3 reports`. Change it to treat a legitimately
deferred account (a `provisional-empty` / readiness-pending account with no publishable coverage yet) as
**permitted-absent**: the cycle finalizes honestly **partial** over the accounts that can publish; the deferred
account keeps its LKG and is retried next cycle. This is the direct fix for the region-stall risk and mirrors the
existing partial-publication preflight (`partitionPartialCycleByLineage`) — extend it so a `provisional-empty` account
is a first-class "not yet, retry" member, never a hard blocker of its peers.

### C. Partial-history publication (break the gapless deadlock)

Relax the gapless-from-2025-01-01 contract so an account publishes over the coverage it **has** (its proven data era):

- `resolveEffectivePublishAsOf`: a **leading `provisional-empty`** window is not a hard blocker — the account
  publishes from its earliest proven date, and the pre-coverage stretch renders **Unavailable** (the display layer in
  this patch), instead of deferring the whole report. A **`final-empty`** leading window is a genuine zero-covered
  window and publishes normally (GBP 0 where truly zero).
- This breaks the deadlock: a new seller publishes its real recent data **immediately** over its proven era; its deep-
  history `provisional-empty` finalizes in the background; nothing blocks grading to `ready`.

## Why this is correct for both canonical accounts

| account | deep-history empty window | outcome |
|---|---|---|
| **flexii** (data exists at DataDoe, unloaded) | recorded `provisional-empty` | derive shows Jun–Aug as **Unavailable**, never GBP 0; once DataDoe finishes loading (or the approved backfill runs) the window returns real data → `succeeded` → real sales. |
| **genuinely-new zero-sales seller** | recorded `provisional-empty` | publishes its **real recent data immediately** (partial-history publication); after the confirmation horizon the deep window becomes `final-empty` → honest GBP 0. **No deadlock, no region stall.** |

## Rollout, risk, sequencing

- Additive gated migration for the `source_coverage` status lifecycle.
- The confirmation horizon `N` + the load-stability signal require an empirical probe of DataDoe's initial-load SLA
  (how long deep history takes to materialize per region) to be set safely.
- Heavily-tested contracts are touched — `source_coverage` semantics, `resolveEffectivePublishAsOf`, `finalizeBucket`,
  `partitionPartialCycleByLineage` — each needs its own adversarial re-review before shipping.
- flexii's **existing** false `succeeded` coverage (Jan-2025+) is **not** auto-corrected by this design; it is
  corrected by the approved backfill's `replaceHistoryWindow` overwrite, or by a one-off flexii-scoped reclassification
  of its false `succeeded`-empty windows to `provisional-empty`.

This design is intentionally **not** implemented in the current patch, which is limited to the honest display of
coverage (uncovered/partial/unknown → Unavailable/em dash, never a fabricated zero).
