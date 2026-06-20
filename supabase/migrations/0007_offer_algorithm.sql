-- Restash — algorithmic offers + minimum-submission rule + pricing config.
--
-- editions.base now means the MARKET VALUE of a Complete (CIB) copy. The
-- condition multiplier derives the per-condition market value, and our offer is
-- computed by a strict algorithm:
--
--   offer = (sum of  market_value x target_margin)  - shipping - processing fee
--
-- target_margin is tiered by each game's market value (low-value games are
-- mostly eaten by shipping, so we offer a smaller %; high-value/retro games
-- allow a higher %). All knobs live in pricing_config so staff can tune them
-- without code. Market values are meant to be refreshed from a pricing API
-- (see supabase/functions/price-sync); the seed numbers are placeholders.

create table if not exists pricing_config (
  id            int primary key default 1,
  margin_low    numeric not null default 0.35,  -- market value < tier_mid_min (30–40%)
  margin_mid    numeric not null default 0.45,  -- tier_mid_min .. tier_high_min
  margin_high   numeric not null default 0.57,  -- >= tier_high_min (50–65%)
  tier_mid_min  int     not null default 20,
  tier_high_min int     not null default 50,
  ship_cost     numeric not null default 4.50,  -- estimated shipping per claim
  fee_pct       numeric not null default 0.029, -- payment processing %
  fee_flat      numeric not null default 0.30,  -- payment processing flat
  min_quote     int     not null default 25,    -- submit if offer >= this ...
  min_games     int     not null default 3,     -- ... OR total games >= this
  constraint pricing_config_singleton check (id = 1)
);
insert into pricing_config (id) values (1) on conflict (id) do nothing;

alter table pricing_config enable row level security;
create policy "pricing read" on pricing_config for select using (true);
grant select on pricing_config to anon, authenticated;

-- per-line market value snapshot (unit market value at the current grade)
alter table claim_items add column if not exists unit_market numeric not null default 0;

-- Target margin for a single game's market value.
create or replace function public.margin_for(p_unit numeric)
returns numeric language plpgsql stable set search_path = public as $$
declare cfg pricing_config;
begin
  select * into cfg from pricing_config where id = 1;
  if p_unit >= cfg.tier_high_min then return cfg.margin_high; end if;
  if p_unit >= cfg.tier_mid_min  then return cfg.margin_mid;  end if;
  return cfg.margin_low;
end; $$;

-- The strict offer algorithm for a whole claim.
create or replace function public.compute_offer(p_claim uuid)
returns int language plpgsql stable security definer set search_path = public as $$
declare cfg pricing_config; sub numeric := 0; it record; offer numeric;
begin
  select * into cfg from pricing_config where id = 1;
  for it in select unit_market, qty from claim_items where claim_id = p_claim loop
    sub := sub + it.unit_market * it.qty * margin_for(it.unit_market);
  end loop;
  if sub <= 0 then return 0; end if;
  offer := sub - cfg.ship_cost - (sub * cfg.fee_pct + cfg.fee_flat);
  if offer < 0 then offer := 0; end if;
  return round(offer)::int;
end; $$;

-- Drop the old assessed helper (replaced by compute_offer).
drop function if exists public.claim_assessed(uuid);

-- submit_claim: market-value pricing, algorithmic estimate, min-submission rule.
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

    v_unit := v_ed.base * v_cond.mult;             -- per-unit market value at this grade
    v_games := v_games + v_qty;
    v_pos := v_pos + 1;
    insert into claim_items (claim_id, title_name, platform_name, edition_name, cond_name, qty, line_mid, position, edition_id, condition_id, unit_market)
    values (v_claim, v_tit.name, v_plat.name, v_ed.name, v_cond.name, v_qty, round(v_unit * v_qty)::int, v_pos, v_ed.id, v_cond.id, v_unit);
  end loop;

  v_offer := compute_offer(v_claim);              -- algorithmic offer at claimed condition

  -- Minimum-submission rule: offer >= min_quote OR total games >= min_games
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

-- regrade_item: recompute the item's market value at the new grade.
create or replace function public.regrade_item(p_item_id uuid, p_condition_id text)
returns void language plpgsql security definer set search_path = public as $$
declare it claim_items; c claims; ed editions; cond conditions; v_old text; v_unit numeric;
begin
  if not is_staff() then raise exception 'Staff only'; end if;
  select * into it from claim_items where id = p_item_id;     if not found then raise exception 'Item not found'; end if;
  select * into c from claims where id = it.claim_id;
  if c.status <> 'received' then raise exception 'Items can only be re-graded during inspection'; end if;
  if it.edition_id is null then raise exception 'Item is missing its edition reference'; end if;
  select * into cond from conditions where id = p_condition_id; if not found then raise exception 'Unknown condition'; end if;
  select * into ed from editions where id = it.edition_id;

  v_old := it.cond_name;
  v_unit := ed.base * cond.mult;
  update claim_items set condition_id = cond.id, cond_name = cond.name, unit_market = v_unit, line_mid = round(v_unit * it.qty)::int where id = it.id;

  if v_old is distinct from cond.name then
    perform _push_history(c.id, 'Re-graded ' || it.title_name || ': ' || v_old || ' → ' || cond.name, 'Condition confirmed on inspection.');
  end if;
end; $$;

-- make_offer: guardrail now centers on the algorithmic offer (±15%).
create or replace function public.make_offer(p_ref text, p_amount int, p_reason text default '')
returns void language plpgsql security definer set search_path = public as $$
declare c claims := _claim_for_staff(p_ref); v_sugg int; v_lo int; v_hi int;
begin
  if c.status <> 'received' then raise exception 'Can only offer on a received claim'; end if;
  v_sugg := compute_offer(c.id);
  v_lo := greatest(1, floor(v_sugg * 0.85)::int);
  v_hi := greatest(v_lo, ceil(v_sugg * 1.15)::int);
  if p_amount is null or p_amount < v_lo or p_amount > v_hi then
    raise exception 'Offer must be between $% and $% for this claim (algorithm suggests $%)', v_lo, v_hi, v_sugg;
  end if;
  update claims set status='offer', offer_amount=p_amount, customer_response=null, updated_at=now() where id = c.id;
  perform _push_history(c.id, 'Offer made: $' || p_amount, nullif(trim(p_reason),''));
end; $$;

-- Better placeholder MARKET values (Complete/CIB) until the pricing feed is wired.
update editions set base = 45 where title_id='mk8d'    and edition_key='std';
update editions set base = 52 where title_id='smash'   and edition_key='std';
update editions set base = 55 where title_id='totk'    and edition_key='std';
update editions set base = 42 where title_id='odyssey' and edition_key='std';
update editions set base = 18 where title_id='gow'     and edition_key='std';
update editions set base = 12 where title_id='gow'     and edition_key='hits';
update editions set base = 14 where title_id='witcher' and edition_key='std';
update editions set base = 28 where title_id='witcher' and edition_key='goty';
update editions set base = 22 where title_id='rdr2'    and edition_key='std';
update editions set base = 20 where title_id='spider'  and edition_key='std';
update editions set base = 16 where title_id='halomcc' and edition_key='std';
update editions set base = 19 where title_id='forza4'  and edition_key='std';
update editions set base = 20 where title_id='rdr2x'   and edition_key='std';
update editions set base = 14 where title_id='gtav'    and edition_key='std';
