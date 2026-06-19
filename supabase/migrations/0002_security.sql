-- Restash — security: helper, triggers, and Row-Level Security.

-- ------------------------------------------------------------------
-- Role helper. SECURITY DEFINER so it reads profiles without tripping
-- the RLS policies that themselves call it (avoids recursion).
-- ------------------------------------------------------------------
create or replace function public.is_staff()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'staff'
  );
$$;

-- ------------------------------------------------------------------
-- Create a profile automatically when a user signs up. Name/phone come
-- from signUp metadata; role is always 'customer' here (staff is granted
-- later by an admin — see SUPABASE-SETUP.md).
-- ------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email, phone)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data->>'phone', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------------
-- Stop a customer from escalating their own role or clearing a flag.
-- Non-staff updates are forced back to the existing role/flag values.
-- ------------------------------------------------------------------
create or replace function public.protect_profile_privileges()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Guard only authenticated, non-staff callers. The service role / SQL editor
  -- (auth.uid() is null) is already privileged and may bootstrap the first staff.
  if auth.uid() is not null and not public.is_staff() then
    new.role := old.role;
    new.flagged := old.flagged;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_profile_privileges_trg on public.profiles;
create trigger protect_profile_privileges_trg
  before update on public.profiles
  for each row execute function public.protect_profile_privileges();

-- ------------------------------------------------------------------
-- Enable RLS everywhere
-- ------------------------------------------------------------------
alter table platforms     enable row level security;
alter table titles        enable row level security;
alter table editions      enable row level security;
alter table conditions    enable row level security;
alter table profiles      enable row level security;
alter table team_members  enable row level security;
alter table claims        enable row level security;
alter table claim_items   enable row level security;
alter table claim_history enable row level security;
alter table claim_notes   enable row level security;
alter table account_notes enable row level security;

-- Catalog: world-readable (the customer app needs it before login).
-- No write policies -> only the service role / SQL can change pricing.
create policy "catalog read platforms"  on platforms  for select using (true);
create policy "catalog read titles"      on titles     for select using (true);
create policy "catalog read editions"    on editions   for select using (true);
create policy "catalog read conditions"  on conditions for select using (true);

-- Profiles: you can see/edit your own; staff can see/edit all.
create policy "profiles select own or staff" on profiles
  for select using (id = auth.uid() or public.is_staff());
create policy "profiles update own or staff" on profiles
  for update using (id = auth.uid() or public.is_staff());
-- (inserts happen via the signup trigger; no client insert policy)

-- Team directory: staff only.
create policy "team staff read" on team_members
  for select using (public.is_staff());

-- Claims: customers see only their own; staff see all.
create policy "claims select own or staff" on claims
  for select using (customer_id = auth.uid() or public.is_staff());
-- All writes go through SECURITY DEFINER RPCs (0003); no direct client write policies.

-- Claim children: visible if you can see the parent claim.
create policy "claim_items select via claim" on claim_items
  for select using (exists (
    select 1 from claims c
    where c.id = claim_items.claim_id
      and (c.customer_id = auth.uid() or public.is_staff())
  ));
create policy "claim_history select via claim" on claim_history
  for select using (exists (
    select 1 from claims c
    where c.id = claim_history.claim_id
      and (c.customer_id = auth.uid() or public.is_staff())
  ));

-- Internal notes: staff only.
create policy "claim_notes staff read"   on claim_notes   for select using (public.is_staff());
create policy "account_notes staff read" on account_notes for select using (public.is_staff());

-- ------------------------------------------------------------------
-- Table privileges for the API roles. RLS (above) gates the rows; these
-- grants let the roles reach the tables at all. Writes are intentionally
-- not granted — every change goes through a SECURITY DEFINER RPC (0003).
-- ------------------------------------------------------------------
grant usage on schema public to anon, authenticated;
-- Catalog is needed before login, so anon may read it too.
grant select on platforms, titles, editions, conditions to anon, authenticated;
-- Signed-in users may read (RLS restricts which rows).
grant select on profiles, claims, claim_items, claim_history, claim_notes, account_notes, team_members
  to authenticated;
-- Profile self-edit (name/phone/address) is a direct update gated by RLS +
-- the privilege trigger; everything else flows through RPCs.
grant update on profiles to authenticated;
