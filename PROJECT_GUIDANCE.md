# Shared Project Guidance and Rules

This is the **single canonical file** for durable project instructions shared
by Codex, Claude, and other repository agents.

## Maintenance Rule

- Add or change durable guidance only in this file.
- Do not duplicate project rules in `AGENTS.md`, `CLAUDE.md`, prompts, or other
  documents. Those agent-specific files are loader pointers only.
- `PROJECT_MEMORY.md` records historical outcomes and evidence; this file holds
  the current rules that agents must follow.
- When a remembered fact conflicts with code or current source evidence, verify
  it before updating this file or acting on it.

## DataDoe Export and Backfill Guardrails

This file is the durable source of truth for agents planning or executing a
DataDoe export, diagnostic probe, historical backfill, or publication repair.
Read it before touching production data or estimating token cost.

### 1. DataDoe export limits (hard rule)

The repository owner received direct confirmation from the DataDoe team and
recorded it here on 2026-09-21. This is the current provider contract:

- **Every DataDoe report/source permits up to 50,000 rows in one export.**
- **One export may include at most 5 sellers.**
- The 50,000-row ceiling and 5-seller batching ceiling are independent.
- Order Line Items (OLI) is a standard source and costs 2 tokens per
  create-export.

Treat repository OLI constants/comments that still say 5,000 as stale
application constraints, not as the DataDoe provider contract. In particular,
`OLI_SALES_ROW_LIMIT`, `ORDER_SALES_ROW_LIMIT`, their mirrored scheduler
contracts, Supabase read defaults, tests, and comments must be audited and
corrected to 50,000 before the flexii OLI backfill. Preserve strict behavior:
an export returning exactly 50,000 rows is potentially truncated and must not
be persisted as complete.

Before every operation, re-open the source registry and request builder to
confirm the application matches this provider contract. If a live create
rejects 50,000 or DataDoe supplies a newer written contract, stop and report
contract drift; do not silently fall back, spend additional tokens, or record
false coverage.

### 2. Mandatory preflight before a paid action

Before the first create-export call, write down and verify all of the following:

1. Account public ID and raw seller/account ID.
2. DataDoe connection/organization and authoritative marketplace.
3. Source ID, report key, grain, grouping, and requested columns.
4. Requested date range and whether the operation must bypass existing coverage.
5. The 50,000-row provider limit, 5-seller batch limit, and confirmation that
   the active application request path implements both correctly.
6. Maximum export creates and maximum token spend approved by the user.
7. Persistence target, overwrite semantics, and downstream rebuild path.
8. Stop conditions, including cap hit, ownership mismatch, currency mismatch,
   duplicate grain, incomplete dates, or unexpected source response.

User approval for investigation is not approval for a paid export. User
approval for a probe is not approval for a full backfill. Never exceed the
explicit account/source/date/token scope.

### 3. Truncation and splitting rules

- A result with `rowCount < sourceLimit` may be complete only after date and
  ownership checks pass.
- A result with `rowCount == sourceLimit` is potentially truncated. Do not
  persist it as complete coverage.
- Split a capped interval into contiguous, non-overlapping subranges and retry
  within the approved create/token ceiling.
- Validate every fragment before persistence: seller/account, marketplace,
  currency, earliest/latest dates, canonical grain, duplicates, sales, units,
  and expected interval ownership.
- Persist only a complete validated interval. Never publish a partial fragment
  as complete coverage.
- Make retries idempotent and resumable. Reuse a completed valid fragment where
  the production contract permits it; never create an uncontrolled fan-out.
- Rebuild dependent reports from restored durable evidence. Do not launch
  unrelated source exports to make downstream reports look complete.

### 4. Token estimates

Token estimates must distinguish:

- expected spend;
- approved hard ceiling; and
- worst-case split/retry exposure.

State the assumed token price per create and the assumed row density. Include
the initial capped request and every possible split in the estimate. A hard
ceiling is not an expected spend. Check the fresh balance before every create
and stop before the next create would exceed the approved ceiling.

### 5. Persistence and truthfulness

- Never infer proven-empty coverage from a blank, capped, failed, pending, or
  otherwise incomplete export.
- Never fabricate zero sales for an uncovered or partially covered period.
- Preserve last-known-good durable data until replacement evidence validates.
- Use the canonical persistence path (for OLI history, including
  `replaceHistoryWindow` where the approved repair calls for it).
- After writes, re-read durable rows and coverage, then run only the required
  reconciliation/materialization from saved evidence.
- Record export IDs, token balance before/after, row/date boundaries, validation
  results, writes, rebuilt reports, and production smoke evidence.

### 6. Current flexii UK recovery facts

These facts prevent the active incident from being re-planned from memory:

- Account: flexii UK.
- Raw seller/account ID: `f08cefca-c527-41d6-a2e7-71a435478f5d`.
- Marketplace/currency: GB / GBP.
- Source: Order Line Items. Per direct DataDoe-team confirmation, its export
  ceiling is **50,000 rows** and the request may contain at most 5 sellers.
- The current repository's OLI 5,000 constants/comments are known stale and
  must be corrected and parity-tested before executing this recovery.
- Required history includes `2025-06-01` onward; the current canonical recovery
  plan requests `2025-01-01` through D-1 to satisfy the gapless history contract.
- Existing broad `source_coverage` is known to be false for the missing history;
  the recovery must force re-fetch instead of allowing the normal coverage
  planner to skip it.
- Diagnostic export `aa462536-bcd0-41ce-a2fe-e01ef58e9145` covered
  `2026-08-19..2026-08-25`: 427 rows, GBP 3,727.33 sales, 427 units, zero
  canonical-grain duplicates, correct seller/GB/GBP ownership. It cost zero
  tokens because DataDoe served it from cache. It was not persisted.
- The observed probe density is about 61 rows/day. At that density, the missing
  `2025-01-01..2026-09-02` interval is roughly 37,000 rows and may fit in one
  50,000-row export costing 2 tokens. This is an estimate, not proof of the
  historical density or final row count.
- Preserve the existing valid Sep 3 onward durable history while replacing the
  false historical coverage with validated rows and truthful intervals.
- As of the creation of this runbook, the full historical backfill has **not**
  started and no additional backfill tokens have been spent.

### 7. Required completion report

Report code state and production data state separately. Include:

- exact account/source/date scope;
- export IDs and token spend;
- fragment row counts and date boundaries;
- validation and duplicate results;
- durable rows/coverage before and after;
- downstream reports rebuilt from saved data;
- tests and production smoke results;
- anything still pending or blocked.

Do not call the incident resolved until durable OLI history, truthful coverage,
derived reports, and the visible flexii date ranges all agree.
