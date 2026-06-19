-- Restash — RPCs. All state changes go through these so pricing, the
-- offer guardrail, and the status machine are enforced server-side
-- (never trusted from the browser). All are SECURITY DEFINER.

-- Unique RS-XXXXXX reference
create or replace function public.gen_claim_ref()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare r text;
begin
  loop
    r := 'RS-' || upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 6));
    exit when not exists (select 1 from claims where ref = r);
  end loop;
  return r;
end;
$$;

-- Append a timeline entry + bump updated_at
create or replace function public._push_history(p_claim uuid, p_label text, p_note text default null)
returns void
language sql
security definer
set search_path = public
as $$
  insert into claim_history (claim_id, label, note) values (p_claim, p_label, p_note);
  update claims set updated_at = now() where id = p_claim;
$$;

-- ------------------------------------------------------------------
-- CUSTOMER: submit a claim. Prices are recomputed here from the catalog;
-- the client's numbers are ignored. p_items = [{edition_id, condition_id, qty}, ...]
-- ------------------------------------------------------------------
create or replace function public.submit_claim(
  p_items   jsonb,
  p_payout  text,
  p_phone   text default '',
  p_address text default '',
  p_notes   text default ''
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_prof  profiles;
  v_item  jsonb;
  v_ed    editions;
  v_cond  conditions;
  v_tit   titles;
  v_plat  platforms;
  v_qty   int;
  v_line  int;
  v_mid   int := 0;
  v_ref   text;
  v_claim uuid;
  v_pos   int := 0;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  select * into v_prof from profiles where id = v_uid;
  if not found then raise exception 'Profile missing'; end if;
  if p_payout not in ('PayPal','Check') then raise exception 'Invalid payout method'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'No games in claim';
  end if;
  if p_payout = 'Check' and coalesce(nullif(trim(p_address), ''), '') = '' then
    raise exception 'Mailing address required for check payouts';
  end if;

  v_ref := gen_claim_ref();
  insert into claims (ref, customer_id, cust_name, cust_email, cust_phone,
                      est_low, est_high, payout, address, customer_notes, status)
  values (v_ref, v_uid, v_prof.full_name, v_prof.email,
          coalesce(nullif(trim(p_phone), ''), v_prof.phone),
          0, 0, p_payout, coalesce(p_address, ''), coalesce(p_notes, ''), 'submitted')
  returning id into v_claim;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := greatest(1, coalesce((v_item->>'qty')::int, 1));
    select * into v_ed   from editions   where id = (v_item->>'edition_id')::uuid;
    if not found then raise exception 'Unknown edition'; end if;
    select * into v_cond from conditions where id = (v_item->>'condition_id');
    if not found then raise exception 'Unknown condition'; end if;
    if v_cond.ineligible then raise exception 'Ineligible condition for an item'; end if;
    select * into v_tit  from titles    where id = v_ed.title_id;
    select * into v_plat from platforms where id = v_tit.platform_id;

    v_line := round(v_ed.base * v_cond.mult)::int * v_qty;
    v_mid  := v_mid + v_line;
    v_pos  := v_pos + 1;
    insert into claim_items (claim_id, title_name, platform_name, edition_name, cond_name, qty, line_mid, position)
    values (v_claim, v_tit.name, v_plat.name, v_ed.name, v_cond.name, v_qty, v_line, v_pos);
  end loop;

  update claims set est_low = round(v_mid * 0.9), est_high = round(v_mid * 1.1) where id = v_claim;

  -- keep the profile's contact details fresh
  update profiles set
    phone   = coalesce(nullif(trim(p_phone), ''), phone),
    address = case when p_payout = 'Check' and trim(p_address) <> '' then p_address else address end
  where id = v_uid;

  perform _push_history(v_claim, 'Claim submitted');
  return v_ref;
end;
$$;

-- ------------------------------------------------------------------
-- CUSTOMER: accept or decline an offer. Locks the claim into the
-- customer's choice; staff then authorize payout or confirm the return.
-- ------------------------------------------------------------------
create or replace function public.respond_to_offer(p_ref text, p_response text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare c claims;
begin
  if p_response not in ('accepted','declined') then raise exception 'Invalid response'; end if;
  select * into c from claims where ref = p_ref;
  if not found then raise exception 'Claim not found'; end if;
  if c.customer_id <> auth.uid() then raise exception 'Not your claim'; end if;
  if c.status <> 'offer' then raise exception 'No open offer on this claim'; end if;
  if c.customer_response is not null then raise exception 'You already responded'; end if;

  update claims set customer_response = p_response, updated_at = now() where id = c.id;
  if p_response = 'accepted' then
    perform _push_history(c.id, 'You accepted the offer');
  else
    perform _push_history(c.id, 'You declined the offer', 'We''ll return your games and email tracking.');
  end if;
end;
$$;

-- ------------------------------------------------------------------
-- STAFF lifecycle actions
-- ------------------------------------------------------------------
create or replace function public._claim_for_staff(p_ref text)
returns claims
language plpgsql
security definer
set search_path = public
as $$
declare c claims;
begin
  if not is_staff() then raise exception 'Staff only'; end if;
  select * into c from claims where ref = p_ref;
  if not found then raise exception 'Claim not found'; end if;
  return c;
end;
$$;

create or replace function public.review_claim(p_ref text) returns void
language plpgsql security definer set search_path = public as $$
declare c claims := _claim_for_staff(p_ref);
begin
  if c.status not in ('submitted') then raise exception 'Can only review a new claim'; end if;
  update claims set status = 'reviewing', updated_at = now() where id = c.id;
  perform _push_history(c.id, 'Under review');
end; $$;

create or replace function public.accept_claim(p_ref text) returns void
language plpgsql security definer set search_path = public as $$
declare c claims := _claim_for_staff(p_ref);
begin
  if c.status not in ('submitted','reviewing') then raise exception 'Claim is not pending review'; end if;
  update claims set status = 'accepted', updated_at = now() where id = c.id;
  perform _push_history(c.id, 'Accepted — shipping label emailed');
end; $$;

create or replace function public.decline_claim(p_ref text) returns void
language plpgsql security definer set search_path = public as $$
declare c claims := _claim_for_staff(p_ref);
begin
  if c.status not in ('submitted','reviewing') then raise exception 'Claim is not pending review'; end if;
  update claims set status = 'declined', updated_at = now() where id = c.id;
  perform _push_history(c.id, 'Declined — not accepted');
end; $$;

create or replace function public.mark_received(p_ref text) returns void
language plpgsql security definer set search_path = public as $$
declare c claims := _claim_for_staff(p_ref);
begin
  if c.status <> 'accepted' then raise exception 'Claim is not awaiting arrival'; end if;
  update claims set status = 'received', updated_at = now() where id = c.id;
  perform _push_history(c.id, 'Games received at facility');
end; $$;

-- Offer guardrail: 70%–110% of the customer-estimate midpoint, enforced here.
create or replace function public.make_offer(p_ref text, p_amount int) returns void
language plpgsql security definer set search_path = public as $$
declare c claims := _claim_for_staff(p_ref);
        v_mid int; v_lo int; v_hi int;
begin
  if c.status <> 'received' then raise exception 'Can only offer on a received claim'; end if;
  v_mid := round((c.est_low + c.est_high) / 2.0);
  v_lo  := greatest(1, round(v_mid * 0.7));
  v_hi  := round(v_mid * 1.1);
  if p_amount is null or p_amount < v_lo or p_amount > v_hi then
    raise exception 'Offer must be between $% and $% for this claim', v_lo, v_hi;
  end if;
  update claims set status = 'offer', offer_amount = p_amount, customer_response = null, updated_at = now()
   where id = c.id;
  perform _push_history(c.id, 'Offer made: $' || p_amount, 'Awaiting customer response.');
end; $$;

create or replace function public.reject_return(p_ref text) returns void
language plpgsql security definer set search_path = public as $$
declare c claims := _claim_for_staff(p_ref);
begin
  if c.status <> 'received' then raise exception 'Claim is not in inspection'; end if;
  update claims set status = 'returned', updated_at = now() where id = c.id;
  perform _push_history(c.id, 'Rejected on inspection — returning to seller', 'We''ll email tracking.');
end; $$;

create or replace function public.authorize_payment(p_ref text) returns void
language plpgsql security definer set search_path = public as $$
declare c claims := _claim_for_staff(p_ref);
begin
  if c.status <> 'offer' or c.customer_response <> 'accepted' then
    raise exception 'Customer has not accepted an offer on this claim';
  end if;
  update claims set status = 'paid', paid_amount = c.offer_amount, paid_method = c.payout,
                    paid_at = now(), updated_at = now()
   where id = c.id;
  perform _push_history(c.id, 'Payment authorized via ' || c.payout,
    case when c.payout = 'PayPal' then 'PayPal 1–3 business days.' else 'Check 3–5 business days.' end);
end; $$;

create or replace function public.confirm_return(p_ref text) returns void
language plpgsql security definer set search_path = public as $$
declare c claims := _claim_for_staff(p_ref);
begin
  if c.status <> 'offer' or c.customer_response <> 'declined' then
    raise exception 'No declined offer to return on this claim';
  end if;
  update claims set status = 'returned', updated_at = now() where id = c.id;
  perform _push_history(c.id, 'Games returned to seller', 'We''ll email tracking.');
end; $$;

create or replace function public.assign_claim(p_ref text) returns void
language plpgsql security definer set search_path = public as $$
declare c claims := _claim_for_staff(p_ref);
        v_name text;
begin
  select full_name into v_name from profiles where id = auth.uid();
  update claims set assignee_id = auth.uid(), assignee_name = v_name, updated_at = now() where id = c.id;
  perform _push_history(c.id, coalesce(v_name,'A teammate') || ' is handling this claim');
end; $$;

create or replace function public.release_claim(p_ref text) returns void
language plpgsql security definer set search_path = public as $$
declare c claims := _claim_for_staff(p_ref);
begin
  perform _push_history(c.id, coalesce(c.assignee_name,'A teammate') || ' released this claim');
  update claims set assignee_id = null, assignee_name = null, updated_at = now() where id = c.id;
end; $$;

create or replace function public.set_claim_flag(p_ref text, p_flag boolean) returns void
language plpgsql security definer set search_path = public as $$
declare c claims := _claim_for_staff(p_ref);
begin
  update claims set flagged = p_flag, updated_at = now() where id = c.id;
end; $$;

create or replace function public.add_claim_note(p_ref text, p_body text) returns void
language plpgsql security definer set search_path = public as $$
declare c claims := _claim_for_staff(p_ref);
        v_name text;
begin
  if coalesce(trim(p_body),'') = '' then raise exception 'Empty note'; end if;
  select full_name into v_name from profiles where id = auth.uid();
  insert into claim_notes (claim_id, body, author_id, author_name)
  values (c.id, p_body, auth.uid(), coalesce(v_name,''));
end; $$;

create or replace function public.set_account_flag(p_profile uuid, p_flag boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_staff() then raise exception 'Staff only'; end if;
  update profiles set flagged = p_flag where id = p_profile;
end; $$;

create or replace function public.add_account_note(p_profile uuid, p_body text) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if not is_staff() then raise exception 'Staff only'; end if;
  if coalesce(trim(p_body),'') = '' then raise exception 'Empty note'; end if;
  select full_name into v_name from profiles where id = auth.uid();
  insert into account_notes (profile_id, body, author_id, author_name)
  values (p_profile, p_body, auth.uid(), coalesce(v_name,''));
end; $$;

-- Lock down: only authenticated users may call these (RLS still applies inside).
revoke all on function public.submit_claim(jsonb,text,text,text,text) from anon;
revoke all on function public.respond_to_offer(text,text)            from anon;
