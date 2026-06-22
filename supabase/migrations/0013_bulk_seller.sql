-- Restash — Bulk Seller program (beta).
--
-- Approved sellers skip the one-by-one buyback flow and ship lots straight to
-- Restash. Entry is gated by HARD requirements and approved by staff:
--   * >= 25 lifetime paid claims, in good standing
--   * >= 30 days on Restash
--   * a government ID (confirmed by staff out of band)
--   * the signed Bulk Seller agreement
-- Once active: >= 25 paid claims/month (or suspended), >= 10 games/shipment,
-- and no counterfeits / ownership issues / repeated mismatches (immediate
-- closure). Status lives on the profile and drives both surfaces.

-- 1. Columns -------------------------------------------------------------
alter table profiles
  add column if not exists bulk_status      text
    check (bulk_status in ('pending','approved','suspended','declined','closed')),
  add column if not exists bulk_reason       text   not null default '',
  add column if not exists bulk_applied_at   timestamptz,
  add column if not exists bulk_decided_at   timestamptz,
  add column if not exists bulk_agreement_at timestamptz,
  add column if not exists bulk_id_provided  boolean not null default false,
  -- Paid claims completed before launch / not represented as individual rows.
  -- Eligibility counts this plus live paid claims.
  add column if not exists lifetime_paid     integer not null default 0;

-- 2. Guard: customers must not set their own bulk_* fields directly. Normal
-- profile saves (name/phone/address) still work because the trigger only fires
-- when a bulk_* column actually changes. Our SECURITY DEFINER functions set a
-- transaction-local flag so they're allowed through; staff are always allowed.
create or replace function public.protect_bulk_columns()
returns trigger
language plpgsql
as $$
begin
  if (new.bulk_status      is distinct from old.bulk_status)
  or (new.bulk_reason      is distinct from old.bulk_reason)
  or (new.bulk_applied_at  is distinct from old.bulk_applied_at)
  or (new.bulk_decided_at  is distinct from old.bulk_decided_at)
  or (new.bulk_agreement_at is distinct from old.bulk_agreement_at)
  or (new.bulk_id_provided is distinct from old.bulk_id_provided)
  or (new.lifetime_paid    is distinct from old.lifetime_paid) then
    if coalesce(current_setting('restash.bulk_ok', true), '') <> '1'
       and not public.is_staff() then
      raise exception 'Bulk Seller status can only be changed through the program.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_protect_bulk on profiles;
create trigger trg_protect_bulk before update on profiles
  for each row execute function public.protect_bulk_columns();

-- 3. Eligibility helper: lifetime paid claims for a profile. ---------------
create or replace function public.bulk_paid_claims(p_profile uuid)
returns integer
language sql
stable
as $$
  select coalesce((select lifetime_paid from profiles where id = p_profile), 0)
       + coalesce((select count(*) from claims
                    where customer_id = p_profile and status = 'paid'), 0);
$$;

-- 4. CUSTOMER: apply to the program. Validates the hard requirements server
-- side (client numbers are never trusted) and moves the seller to 'pending'.
create or replace function public.apply_bulk_seller(p_agreement boolean, p_id_provided boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_prof   profiles%rowtype;
  v_paid   integer;
  v_age    integer;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  select * into v_prof from profiles where id = v_uid;
  if v_prof.bulk_status = 'pending'  then raise exception 'Your application is already under review.'; end if;
  if v_prof.bulk_status = 'approved' then raise exception 'You are already an approved Bulk Seller.'; end if;
  if v_prof.bulk_status = 'suspended' then raise exception 'Your Bulk Seller status is suspended.'; end if;
  if not coalesce(p_agreement, false)  then raise exception 'You must accept the Bulk Seller agreement.'; end if;
  if not coalesce(p_id_provided, false) then raise exception 'You must confirm you can provide a government ID.'; end if;

  v_paid := public.bulk_paid_claims(v_uid);
  v_age  := floor(extract(epoch from (now() - v_prof.created_at)) / 86400);
  if v_paid < 25 then raise exception 'You need at least 25 paid claims (you have %).', v_paid; end if;
  if v_age  < 30 then raise exception 'Your account must be at least 30 days old.'; end if;

  perform set_config('restash.bulk_ok', '1', true);
  update profiles set
    bulk_status      = 'pending',
    bulk_applied_at  = now(),
    bulk_agreement_at = now(),
    bulk_id_provided = true,
    bulk_reason      = '',
    bulk_decided_at  = null
  where id = v_uid;
end;
$$;

-- 5. STAFF: decide on an application / membership. p_decision is one of
-- approve | reinstate | decline | suspend | close. Decline/suspend/close carry
-- a reason shown to the seller on their account.
create or replace function public.decide_bulk_seller(p_profile uuid, p_decision text, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_status text;
begin
  if not public.is_staff() then raise exception 'Staff only'; end if;
  v_status := case p_decision
    when 'approve'   then 'approved'
    when 'reinstate' then 'approved'
    when 'decline'   then 'declined'
    when 'suspend'   then 'suspended'
    when 'close'     then 'closed'
    else null end;
  if v_status is null then raise exception 'Unknown decision: %', p_decision; end if;

  perform set_config('restash.bulk_ok', '1', true);
  update profiles set
    bulk_status     = v_status,
    bulk_reason     = case when p_decision in ('approve','reinstate') then '' else coalesce(p_reason, '') end,
    bulk_decided_at = now()
  where id = p_profile;
end;
$$;

-- 6. Permissions: only authenticated users may apply; decisions are staff-only
-- (enforced in-body). anon gets nothing.
revoke all on function public.apply_bulk_seller(boolean, boolean) from anon;
revoke all on function public.decide_bulk_seller(uuid, text, text) from anon;
revoke all on function public.bulk_paid_claims(uuid) from anon;
