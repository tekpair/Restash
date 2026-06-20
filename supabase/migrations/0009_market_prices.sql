-- Restash — real per-condition market values from PriceCharting.
--
-- The PriceCharting Prices API returns three prices per game that map exactly to
-- our conditions:  loose-price -> Loose,  cib-price -> Complete,  new-price ->
-- Sealed. We store all three so the offer uses the real market spread instead of
-- a flat multiplier. editions.base stays = Complete (CIB) value (back-compat /
-- fallback). When a per-condition value is missing we fall back to base × the
-- condition multiplier, so nothing breaks before a sync runs.

alter table editions
  add column if not exists loose_market numeric,   -- PriceCharting loose-price ($)
  add column if not exists new_market   numeric;   -- PriceCharting new-price ($)

-- Resolve the market value of a specific edition at a specific condition.
create or replace function public.edition_market(p_edition_id uuid, p_condition_id text)
returns numeric language plpgsql stable security definer set search_path = public as $$
declare e editions; c conditions;
begin
  select * into e from editions   where id = p_edition_id;   if not found then return 0; end if;
  select * into c from conditions where id = p_condition_id; if not found then return 0; end if;
  if p_condition_id = 'loose'    then return coalesce(e.loose_market, e.base * c.mult); end if;
  if p_condition_id = 'complete' then return e.base; end if;
  if p_condition_id = 'sealed'   then return coalesce(e.new_market,  e.base * c.mult); end if;
  return e.base * c.mult;  -- broken (mult 0) or anything else
end; $$;

-- submit_claim: unit market value now comes from edition_market (real
-- per-condition prices when available; multiplier fallback otherwise).
create or replace function public.submit_claim(
  p_items jsonb, p_payout text, p_phone text default '', p_address text default '', p_notes text default ''
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_prof profiles; v_item jsonb;
  v_ed editions; v_cond conditions; v_tit titles; v_plat platforms;
  v_qty int; v_unit numeric; v_pos int := 0; v_games int := 0;
  v_ref text; v_claim uuid; v_offer int; cfg pricing_config;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  select * into v_prof from profiles where id = v_uid;
  if not found then raise exception 'Profile missing'; end if;
  if p_payout not in ('PayPal','Check') then raise exception 'Invalid payout method'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'No games in claim'; end if;
  if p_payout = 'Check' and coalesce(nullif(trim(p_address),''),'') = '' then raise exception 'Mailing address required for check payouts'; end if;
  select * into cfg from pricing_config where id = 1;

  v_ref := gen_claim_ref();
  insert into claims (ref, customer_id, cust_name, cust_email, cust_phone, est_low, est_high, payout, address, customer_notes, status)
  values (v_ref, v_uid, v_prof.full_name, v_prof.email, coalesce(nullif(trim(p_phone),''), v_prof.phone),
          0, 0, p_payout, coalesce(p_address,''), coalesce(p_notes,''), 'submitted')
  returning id into v_claim;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := greatest(1, coalesce((v_item->>'qty')::int, 1));
    select * into v_ed   from editions   where id = (v_item->>'edition_id')::uuid;   if not found then raise exception 'Unknown edition'; end if;
    select * into v_cond from conditions where id = (v_item->>'condition_id');        if not found then raise exception 'Unknown condition'; end if;
    if v_cond.ineligible then raise exception 'Ineligible condition for an item'; end if;
    select * into v_tit  from titles    where id = v_ed.title_id;
    select * into v_plat from platforms where id = v_tit.platform_id;

    v_unit := edition_market(v_ed.id, v_cond.id);   -- real per-condition market value
    v_games := v_games + v_qty;
    v_pos := v_pos + 1;
    insert into claim_items (claim_id, title_name, platform_name, edition_name, cond_name, qty, line_mid, position, edition_id, condition_id, unit_market)
    values (v_claim, v_tit.name, v_plat.name, v_ed.name, v_cond.name, v_qty, round(v_unit * v_qty)::int, v_pos, v_ed.id, v_cond.id, v_unit);
  end loop;

  v_offer := compute_offer(v_claim);
  if v_offer < cfg.min_quote and v_games < cfg.min_games then
    raise exception 'MIN_RULE: A claim needs an estimated offer of at least $% or at least % games. Add more games to continue.', cfg.min_quote, cfg.min_games;
  end if;

  update claims set est_high = v_offer, est_low = round(v_offer * 0.85) where id = v_claim;
  update profiles set phone = coalesce(nullif(trim(p_phone),''), phone),
    address = case when p_payout='Check' and trim(p_address)<>'' then p_address else address end
  where id = v_uid;

  perform _push_history(v_claim, 'Claim submitted');
  return v_ref;
end; $$;

-- regrade_item: recompute via edition_market at the new condition.
create or replace function public.regrade_item(p_item_id uuid, p_condition_id text)
returns void language plpgsql security definer set search_path = public as $$
declare it claim_items; c claims; cond conditions; v_old text; v_unit numeric;
begin
  if not is_staff() then raise exception 'Staff only'; end if;
  select * into it from claim_items where id = p_item_id;     if not found then raise exception 'Item not found'; end if;
  select * into c from claims where id = it.claim_id;
  if c.status <> 'received' then raise exception 'Items can only be re-graded during inspection'; end if;
  if it.edition_id is null then raise exception 'Item is missing its edition reference'; end if;
  select * into cond from conditions where id = p_condition_id; if not found then raise exception 'Unknown condition'; end if;

  v_old := it.cond_name;
  v_unit := edition_market(it.edition_id, cond.id);
  update claim_items set condition_id = cond.id, cond_name = cond.name, unit_market = v_unit, line_mid = round(v_unit * it.qty)::int where id = it.id;

  if v_old is distinct from cond.name then
    perform _push_history(c.id, 'Re-graded ' || it.title_name || ': ' || v_old || ' → ' || cond.name, 'Condition confirmed on inspection.');
  end if;
end; $$;
