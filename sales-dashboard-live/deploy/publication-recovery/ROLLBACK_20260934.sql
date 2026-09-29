-- ROLLBACK (contract) for supabase/migrations/20260934_publication_recovery_worker.sql (the ROUTE design, WP12).
--
-- DELIBERATELY NOT in supabase/migrations/: the ledger-driven runner (scripts/apply-supabase-migrations.mjs) applies
-- every *.sql file there, so a rollback must never live in that directory. Run ONLY with sign-off, AFTER the worker is
-- stopped + disabled on the VM (sudo systemctl disable --now publication-recovery). Paste it into the Supabase SQL
-- editor (never put the connection string on a command line: argv is visible to other processes and shell history).
--
-- Drops EXACTLY the objects 20260934 created (12 functions, 7 tables -- their indexes, constraints and seed rows go with
-- them) and removes its ledger row. It touches no existing table, report snapshot, control-plane lease, source table,
-- sync cycle, the 20260935 writer fence, or any reconciler RPC, so the scheduler / GitHub reconcilers / outbox are
-- unaffected. Worker history is discarded. scripts/worker/publication-recovery-sql-selftest.mjs proves (PGlite) that this
-- file returns the catalog to exactly its pre-20260934 state.
-- Step 1 (optional, reversible): simply disable instead of dropping:
--   update public.publication_recovery_control set enabled = false, updated_at = now(), updated_by = '<operator>' where id = true;
--   update public.publication_recovery_routes set live_enabled = false, live_regions = '{}', updated_at = now(), updated_by = '<operator>';

begin;
drop function if exists public.publication_recovery_status(integer);
drop function if exists public.prune_publication_recovery(integer);
drop function if exists public.finish_publication_recovery_scan(text, text, jsonb, text, jsonb);
drop function if exists public.renew_publication_recovery_scan(text, integer);
drop function if exists public.try_begin_publication_recovery_scan(text, integer, integer, text);
drop function if exists public.beat_publication_recovery_worker(text, text, integer, text, text, timestamptz, text, jsonb);
drop function if exists public.record_publication_recovery_observations(jsonb);
drop function if exists public.record_publication_recovery_baseline(jsonb);
drop function if exists public.finish_publication_recovery_job(uuid, uuid, text, text, text, integer, integer, text, text, jsonb, text, boolean, text, boolean, boolean, integer);
drop function if exists public.renew_publication_recovery_claim(uuid[], uuid, integer);
drop function if exists public.claim_publication_recovery_jobs(text, uuid, integer, integer, integer);
drop function if exists public.enqueue_publication_recovery_job(text, text, text, text[], date, text, text, smallint);
drop table if exists public.publication_recovery_scan;
drop table if exists public.publication_recovery_workers;
drop table if exists public.publication_recovery_observations;
drop table if exists public.publication_recovery_state;
drop table if exists public.publication_recovery_jobs;
drop table if exists public.publication_recovery_control;
drop table if exists public.publication_recovery_routes;
delete from public.app_schema_migrations where filename = '20260934_publication_recovery_worker.sql';
commit;
