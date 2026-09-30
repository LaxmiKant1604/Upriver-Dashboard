# Publish from saved data — runbook

Status when this file was written: code on branch `feat/publish-from-saved-data`. Nothing applied, deployed or activated.

## How it works

1. **Dashboard (Vercel).** A signed-in user clicks **Publish from saved data** on Brand View for one account, one brand and today's date. `api/datadoe.js?action=publish-request` checks, in order:
   - the account grant;
   - that the brand is permitted (a brand-limited user must be permitted exactly that brand);
   - that the brand is in the account's saved brand list;
   - that the date is today's.

   If the exact row the dashboard serves is already current, it answers **Already current**. Otherwise it creates or joins **one** durable request and returns immediately. It never builds, locks or publishes anything.
2. **Queue (Supabase).** `public.publish_requests` plus six service-role-only functions (migration `20260936_publish_requests.sql`). There is at most one active request per report, scope and date, so repeated clicks from any user join the same request. `public.publish_request_control` is the switch.
3. **Executor (one Render background worker).** Before claiming anything, the worker runs cheap load gates. If a gate fails it claims nothing (no attempt is used) and records `paused:<why>` on the control row, which the dashboard shows on a queued request. The database also refuses a second claim while one request holds a live lease, so only one executor ever runs. The pre-claim gates are:
   - a regional scheduler run is in progress;
   - the global lease is held by another operation;
   - the database or auth service is slow.

   After claiming (120 s lease, renewed while it works), it proves the control plane is closed. It safely reclaims a stale window only if that window's lease has expired, and never touches a live owner. Then it publishes exactly that brand through the existing route release and fenced publisher. It holds the global control lease only for a 90 s window, with no waiting. It then reads the served row back and records **Published and verified** or **Already current** only when that row is current. Missing evidence is recorded as **Source data unavailable**, never as zeros and never as a DataDoe fetch.

The only DataDoe call anywhere in the executor is the fenced publisher's existing accounts-list GET (0 tokens). The zero-export guard, loaded first, refuses every other DataDoe request in-process. If one is ever attempted, the executor **trips**: the request fails with `zero-export-violation`, the control row is switched off in the database (`note = 'TRIPPED: ...'`), and the process stays idle, so no restart can resume claiming. To recover after a trip, investigate first, then re-enable with the canary SQL. GitHub Actions and the Oracle VM have no role.

## Supported reports

| Report | Status |
|---|---|
| Brand View (one account + one brand) | Implemented and tested offline; read-only canary measured on production |
| Brand View Portfolio | **Not supported.** Needs its own measured canary: one unit spans every account selling the brand |
| Every other report | Not supported. The control does not render; the endpoint returns 400 `not-supported` |

## Render service (needs owner approval before creation)

| Setting | Value |
|---|---|
| Service type | Background Worker, 1 instance, `autoDeploy: false` (`render.yaml` in this folder) |
| Plan | Smallest: `starter` (0.5 CPU / 512 MB). Measured peak memory for the heaviest Brand View unit: 89 MB |
| Region | Singapore (nearest to Supabase `ap-south-1`) |
| Cost | Confirm on the Render plan picker before creating. This repo could not fetch Render's price table |
| Source | Render must be allowed to read this repo (Render GitHub app, read-only), or deploy a prebuilt image. This is not GitHub Actions |
| Secrets (Render env, `sync: false`) | `POSTGRES_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DATADOE_API_KEY` (only for the publisher's accounts GET) |
| Start command | `node scripts/worker/publish-request-worker.mjs` (SIGTERM: finishes the current request, then exits) |

## Deploy order (each step needs owner approval)

1. **Migration (no behaviour change: the control row starts disabled).**
   ```
   MIGRATE_ONLY=20260936_publish_requests.sql npm run db:migrate
   ```
   Read-only preflight (2026-09-30):
   - the tables and functions do not exist yet;
   - 20260930–20260935 are in the ledger;
   - the `anon` / `authenticated` / `service_role` roles exist;
   - `gen_random_uuid` is available;
   - the control plane is closed and the lease is free.
2. **Vercel.** Deploy a clean archive of the approved commit (it includes Option A `c2885cd`, the sign-in fix and the paid-export authorization fix). With the control disabled the endpoint answers `enabled:false` and no control renders.
   ```
   git archive <commit> | tar -x -C <clean-dir>; cd <clean-dir>/sales-dashboard-live; vercel deploy --prod
   ```
   Rollback: `vercel promote dpl_3R4RUHuy6GCGoj96mZV2XQ5oJJ87` (the current production).
3. **Render worker.** Create it from `render.yaml`, set the four secrets, and deploy. First run `--check-config` from the Render shell: it is read-only and must print `controlPlaneClosed:true`, `cron.ok:true` and zero blocked calls. The worker then idles, because claims return nothing while disabled.
4. **Canary: one Brand View scope.**
   ```sql
   update public.publish_request_control
      set enabled = true, report_keys = '{brand-view}',
          canary_scope_keys = '{brand-view|<account-id>|<exact brand>}', note = 'canary', updated_at = now()
    where id = true;
   ```
   Then, in the owner's signed-in browser: click, and watch the request move through Queued, Publishing and Published and verified. Afterwards check:
   - the `publish_requests` row;
   - the served row (monitoring query below);
   - DataDoe `/usage-logs` since the click: 0 creates.
5. **Expand.** Only after the canary is verified, clear the canary list (`canary_scope_keys = '{}'`) so every Brand View scope is enabled. Portfolio stays off until its own canary.

## Disable immediately

```sql
update public.publish_request_control set enabled = false, updated_at = now() where id = true;
```
- The dashboard stops showing the control on its next status read.
- The worker claims nothing more.
- A request already running finishes, or stops at its 300 s deadline.

To stop the process too, suspend the Render service. A killed executor holds the global control lease for at most 90 s and its request lease for at most 120 s. The next claim resumes the request safely: the release re-proves the live state first.

## Rollback

1. Disable (above) and suspend or delete the Render service.
2. Vercel: `vercel promote dpl_3R4RUHuy6GCGoj96mZV2XQ5oJJ87`.
3. Only if the schema must go, after step 1 and with no active rows:
   ```sql
   drop function if exists public.trip_publish_request_control(text);
   drop function if exists public.publish_request_worker_beat(text, text);
   drop function if exists public.finish_publish_request(uuid, uuid, text, text, jsonb, integer);
   drop function if exists public.renew_publish_request(uuid, uuid, integer);
   drop function if exists public.claim_publish_request(text, uuid, integer);
   drop function if exists public.enqueue_publish_request(text, text, text, text, date, text);
   drop table if exists public.publish_requests;
   drop table if exists public.publish_request_control;
   delete from public.app_schema_migrations where filename = '20260936_publish_requests.sql';
   ```
   Published Brand View rows stay. They are ordinary fenced publications, identical to what the scheduler writes.

## Monitoring (read-only)

```sql
select status, count(*) from public.publish_requests where created_at > now() - interval '1 day' group by 1;
select id, scope_key, as_of, status, reason, attempts, request_count, created_at, finished_at
  from public.publish_requests order by created_at desc limit 20;
select enabled, report_keys, canary_scope_keys, worker_seen_at, worker_state, note from public.publish_request_control;
```

## Tests

| Suite | Scope | How to run |
|---|---|---|
| `scripts/publish-request-endpoint.test.js` | Authorization, states, dedupe, cross-user visibility, contract, UI text, registry lockstep | Part of `npm run verify` |
| `scripts/publish-request-executor.test.js` | The real route release, reconciler and fenced publisher over the offline brand-view world | Part of `npm run verify` |
| `scripts/worker/publish-request-selftest.mjs` | Migration SQL and executor core in PGlite | Opt-in: `PRW_PGLITE_DIR=<dir> node scripts/worker/publish-request-selftest.mjs` |
