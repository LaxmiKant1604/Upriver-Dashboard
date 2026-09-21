# DataDoe Export and Backfill Guardrails

This file is the durable source of truth for agents planning or executing a
DataDoe export, diagnostic probe, historical backfill, or publication repair.
Read it before touching production data or estimating token cost.

## 1. Limits are source-specific

There is no global DataDoe row limit. Identify the exact source/report first,
then verify its current limit in production code and, where applicable, the
DataDoe create contract.

Current verified examples in `api/datadoe.js`:

| Source/report | Code constant | Row limit |
| --- | --- | ---: |
| Order Line Items (OLI) sales | `OLI_SALES_ROW_LIMIT` / `ORDER_SALES_ROW_LIMIT` | **5,000** |
| SKU P&L | `SKU_PL_ROW_LIMIT` | 50,000 |
| Search Query Performance | `SQP_ROW_LIMIT` | 50,000 |
| FBA Inventory Health / plan inventory | `PLAN_INVENTORY_ROW_LIMIT` | 50,000 |
| Reconciliation | `RECONCILIATION_ROW_LIMIT` | 50,000 |

The Order Line Items contract is the important exception: the code records
that DataDoe's current OLI create contract rejects a limit above **5,000**.
Do not substitute a 50,000-row limit from FBA, P&L, SQP, or reconciliation.

Constants can change. Before every operation, re-open the source registry and
request builder used by that operation. If documentation, conversation, and
code disagree, stop and resolve the discrepancy with evidence before creating
an export. Never accept or repeat a correction from memory alone.

## 2. Mandatory preflight before a paid action

Before the first create-export call, write down and verify all of the following:

1. Account public ID and raw seller/account ID.
2. DataDoe connection/organization and authoritative marketplace.
3. Source ID, report key, grain, grouping, and requested columns.
4. Requested date range and whether the operation must bypass existing coverage.
5. The source-specific row limit, cited by constant or contract evidence.
6. Maximum export creates and maximum token spend approved by the user.
7. Persistence target, overwrite semantics, and downstream rebuild path.
8. Stop conditions, including cap hit, ownership mismatch, currency mismatch,
   duplicate grain, incomplete dates, or unexpected source response.

User approval for investigation is not approval for a paid export. User
approval for a probe is not approval for a full backfill. Never exceed the
explicit account/source/date/token scope.

## 3. Truncation and splitting rules

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

## 4. Token estimates

Token estimates must distinguish:

- expected spend;
- approved hard ceiling; and
- worst-case split/retry exposure.

State the assumed token price per create and the assumed row density. Include
the initial capped request and every possible split in the estimate. A hard
ceiling is not an expected spend. Check the fresh balance before every create
and stop before the next create would exceed the approved ceiling.

## 5. Persistence and truthfulness

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

## 6. Current flexii UK recovery facts

These facts prevent the active incident from being re-planned from memory:

- Account: flexii UK.
- Raw seller/account ID: `f08cefca-c527-41d6-a2e7-71a435478f5d`.
- Marketplace/currency: GB / GBP.
- Source: Order Line Items, so the verified export ceiling is **5,000 rows**,
  not 50,000.
- Required history includes `2025-06-01` onward; the current canonical recovery
  plan requests `2025-01-01` through D-1 to satisfy the gapless history contract.
- Existing broad `source_coverage` is known to be false for the missing history;
  the recovery must force re-fetch instead of allowing the normal coverage
  planner to skip it.
- Diagnostic export `aa462536-bcd0-41ce-a2fe-e01ef58e9145` covered
  `2026-08-19..2026-08-25`: 427 rows, GBP 3,727.33 sales, 427 units, zero
  canonical-grain duplicates, correct seller/GB/GBP ownership. It cost zero
  tokens because DataDoe served it from cache. It was not persisted.
- The observed probe density is about 61 rows/day. At that density, one 5,000-row
  OLI export represents about 82 active-selling days. This is an estimate, not
  proof of historical density.
- Preserve the existing valid Sep 3 onward durable history while replacing the
  false historical coverage with validated rows and truthful intervals.
- As of the creation of this runbook, the full historical backfill has **not**
  started and no additional backfill tokens have been spent.

## 7. Required completion report

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
