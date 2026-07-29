-- Supabase Auth + account-level access control for Upriver Dashboard.
-- The initial administrator is the existing workspace owner. Everyone else
-- enters as a viewer and has no Amazon account access until an admin assigns it.

create or replace function public.handle_dashboard_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles (user_id, role, display_name)
  values (
    new.id,
    case when lower(coalesce(new.email, '')) = 'laxmikant@upriver.in'
      then 'admin'::public.dashboard_role
      else 'viewer'::public.dashboard_role
    end,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(coalesce(new.email, ''), '@', 1))
  )
  on conflict (user_id) do update
    set role = case when lower(coalesce(new.email, '')) = 'laxmikant@upriver.in'
      then 'admin'::public.dashboard_role
      else public.user_profiles.role
    end,
        display_name = coalesce(public.user_profiles.display_name, excluded.display_name);
  return new;
end;
$$;

drop trigger if exists on_dashboard_auth_user on auth.users;
create trigger on_dashboard_auth_user
  after insert on auth.users
  for each row execute function public.handle_dashboard_auth_user();

-- Backfill profiles if an Auth user already existed before this migration.
insert into public.user_profiles (user_id, role, display_name)
select
  u.id,
  case when lower(coalesce(u.email, '')) = 'laxmikant@upriver.in'
    then 'admin'::public.dashboard_role
    else 'viewer'::public.dashboard_role
  end,
  coalesce(u.raw_user_meta_data ->> 'display_name', split_part(coalesce(u.email, ''), '@', 1))
from auth.users u
on conflict (user_id) do update
  set role = case when lower(coalesce((select email from auth.users where id = public.user_profiles.user_id), '')) = 'laxmikant@upriver.in'
    then 'admin'::public.dashboard_role
    else public.user_profiles.role
  end;

create or replace function public.is_dashboard_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_profiles
    where user_id = auth.uid() and role = 'admin'
  );
$$;

create policy "Admins can read all user profiles" on public.user_profiles
  for select to authenticated using (public.is_dashboard_admin());
create policy "Admins can update user profiles" on public.user_profiles
  for update to authenticated using (public.is_dashboard_admin())
  with check (public.is_dashboard_admin());
create policy "Admins can read all account assignments" on public.account_permissions
  for select to authenticated using (public.is_dashboard_admin());
create policy "Admins can manage account assignments" on public.account_permissions
  for all to authenticated using (public.is_dashboard_admin())
  with check (public.is_dashboard_admin());
