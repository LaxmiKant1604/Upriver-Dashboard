# Supabase Setup

This directory contains the versioned database foundation for Upriver's
shared report cache, COGS overrides, advertising history, future user roles,
and small realtime refresh signals.

## Provision the project

The Vercel project is already linked as `upriver-dashboard`. Provision one
Supabase resource in the Mumbai region and connect it to Production, Preview,
and Development:

```powershell
& "C:\Users\laxmi\AppData\Roaming\npm\vercel.cmd" integration add supabase --name upriver-shared-data --metadata region=bom1 --metadata publicEnvVarPrefix=VITE_ --environment production --environment preview --environment development --format=json
```

The Vercel Marketplace must first be accepted by an authorised team owner.
Vercel injects `SUPABASE_URL`, `SUPABASE_SECRET_KEY`,
`SUPABASE_PUBLISHABLE_KEY`, and their `VITE_` public equivalents. Never put
`SUPABASE_SECRET_KEY` in a Vite variable, committed file, or browser request.

## Apply the database schema

After the resource exists, open its Supabase dashboard through Vercel and run
`migrations/20260728_shared_dashboard.sql` in the Supabase SQL editor. Then
verify the following tables exist:

- `user_profiles` and `account_permissions`
- `report_snapshots`, `report_refresh_locks`, and `dashboard_events`
- `cogs_overrides` and `ad_daily_metrics`

The `dashboard-snapshots` bucket is private. It is reserved for report bodies
too large for a practical JSON row, such as reconciliation exports.

## Implementation order

1. Verify Vercel has the Supabase environment variables in all three scopes.
2. Apply the migration and test the server-only helper in `api/supabase.js`.
3. Migrate `accounts` and one compact report to shared snapshots.
4. Move COGS overrides to the shared table.
5. Add Supabase Auth, roles, account assignments, and browser Realtime.
6. Move large reports to the private Storage bucket and add the controlled ads
   history sync.

Until these steps are implemented, the dashboard intentionally continues to
use the existing browser cache. No browser may call DataDoe or Supabase with a
secret key.
