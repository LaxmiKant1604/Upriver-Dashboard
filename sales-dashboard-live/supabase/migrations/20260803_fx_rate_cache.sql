-- Upriver exchange-rate cache.
--
-- Added for the account-scoped Brand View currency selector. Money is still
-- never converted unless a user explicitly picks a display currency; when they
-- do, the conversion uses a rate table that was fetched SERVER-SIDE and saved
-- here. Normal dashboard loads read this table and never call the FX provider
-- from a browser.
--
-- One row is one provider observation of one base currency for one rate date.
-- Keeping the provider in the key means a future provider change adds rows
-- instead of overwriting the history that produced an already-exported report.

create table if not exists public.fx_rate_snapshots (
  base_currency text not null,
  rate_date date not null,
  provider text not null,
  -- { "USD": 1, "EUR": 0.8667, ... } as published, at full provider precision.
  rates jsonb not null,
  -- The provider's own freshness fields. `provider_next_update_at` is what lets
  -- the server honour the provider's update interval instead of guessing.
  provider_updated_at timestamptz,
  provider_next_update_at timestamptz,
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (base_currency, rate_date, provider)
);

-- The only access pattern: "the newest saved table for this base currency".
create index if not exists fx_rate_snapshots_latest_idx
  on public.fx_rate_snapshots (base_currency, fetched_at desc);

do $$
begin
  create trigger fx_rate_snapshots_touch_updated_at before update on public.fx_rate_snapshots
    for each row execute function public.touch_updated_at();
exception
  when duplicate_object then null;
end;
$$;

-- RLS is enabled with NO policy on purpose. Exchange rates are read and written
-- only by the Vercel functions using the Supabase secret key. No browser client,
-- signed in or not, may select from this table directly, so a cached rate can
-- never be read outside the API that labels its freshness and fallback state.
alter table public.fx_rate_snapshots enable row level security;
