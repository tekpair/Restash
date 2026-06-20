-- Restash — inspection re-grading.
-- Staff confirm condition on inspection. If a game's real condition differs
-- from what the customer selected, staff re-grade the item: its value is
-- recomputed and the offer band follows the *assessed* (re-graded) value
-- instead of the customer's original estimate. The change is written to the
-- customer-visible history so they see exactly what we found and why.

-- Item-level references so we can recompute value exactly on re-grade.
alter table claim_items
  add column if not exists edition_id   uuid references editions(id),
  add column if not exists condition_id text references conditions(id);

-- submit_claim: same as before, but now records edition_id + condition_id
-- on each item so the grade can be recomputed later.
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
    insert into claim_items (claim_id, title_name, platform_name, edition_name, cond_name,
                             qty, line_mid, position, edition_id, condition_id)
    values (v_claim, v_tit.name, v_plat.name, v_ed.name, v_cond.name,
            v_qty, v_line, v_pos, v_ed.id, v_cond.id);
  end loop;

  update claims set est_low = round(v_mid * 0.9), est_high = round(v_mid * 1.1) where id = v_claim;

  update profiles set
    phone   = coalesce(nullif(trim(p_phone), ''), phone),
    address = case when p_payout = 'Check' and trim(p_address) <> '' then p_address else address end
  where id = v_uid;

  perform _push_history(v_claim, 'Claim submitted');
  return v_ref;
end;
$$;

-- Assessed value of a claim = sum of its items' current (graded) line values.
create or replace function public.claim_assessed(p_claim uuid)
returns int
language sql security definer set search_path = public stable as $$
  select coalesce(sum(line_mid), 0)::int from claim_items where claim_id = p_claim;
$$;

-- STAFF: re-grade one item during inspection. Recomputes its value from the
-- edition base x the new condition multiplier and records it for the customer.
create or replace function public.regrade_item(p_item_id uuid, p_condition_id text)
returns void
language plpgsql security definer set search_path = public as $$
declare it claim_items; c claims; ed editions; cond conditions; v_old text; v_line int;
begin
  if not is_staff() then raise exception 'Staff only'; end if;
  select * into it from claim_items where id = p_item_id;
  if not found then raise exception 'Item not found'; end if;
  select * into c from claims where id = it.claim_id;
  if c.status <> 'received' then raise exception 'Items can only be re-graded during inspection'; end if;
  if it.edition_id is null then raise exception 'Item is missing its edition reference'; end if;
  select * into cond from conditions where id = p_condition_id;
  if not found then raise exception 'Unknown condition'; end if;
  select * into ed from editions where id = it.edition_id;

  v_old  := it.cond_name;
  v_line := round(ed.base * cond.mult)::int * it.qty;
  update claim_items set condition_id = cond.id, cond_name = cond.name, line_mid = v_line where id = it.id;

  if v_old is distinct from cond.name then
    perform _push_history(c.id,
      'Re-graded ' || it.title_name || ': ' || v_old || ' → ' || cond.name,
      'Condition confirmed on inspection.');
  end if;
end; $$;

-- make_offer: guardrail now follows the assessed (re-graded) value, so a
-- legitimate condition downgrade lowers the allowed offer with it.
create or replace function public.make_offer(p_ref text, p_amount int, p_reason text default '')
returns void
language plpgsql security definer set search_path = public as $$
declare c claims := _claim_for_staff(p_ref);
        v_mid int; v_lo int; v_hi int;
begin
  if c.status <> 'received' then raise exception 'Can only offer on a received claim'; end if;
  v_mid := claim_assessed(c.id);
  v_lo  := greatest(1, round(v_mid * 0.7));
  v_hi  := round(v_mid * 1.1);
  if p_amount is null or p_amount < v_lo or p_amount > v_hi then
    raise exception 'Offer must be between $% and $% for this claim (assessed value $%)', v_lo, v_hi, v_mid;
  end if;
  update claims set status = 'offer', offer_amount = p_amount, customer_response = null, updated_at = now()
   where id = c.id;
  perform _push_history(c.id, 'Offer made: $' || p_amount, nullif(trim(p_reason), ''));
end; $$;
