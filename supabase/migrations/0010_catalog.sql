-- Restash — keep the customer's originally-claimed condition, and refresh the
-- catalog to a curated, liquid set with realistic per-condition market values.
--
-- claim_items.claimed_cond_name is set once at submission and never changes, so
-- the console can show "Customer claimed: X" next to the staff re-grade control.

alter table claim_items add column if not exists claimed_cond_name text;

-- submit_claim: also record the claimed condition (immutable).
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

    v_unit := edition_market(v_ed.id, v_cond.id);
    v_games := v_games + v_qty;
    v_pos := v_pos + 1;
    insert into claim_items (claim_id, title_name, platform_name, edition_name, cond_name, claimed_cond_name, qty, line_mid, position, edition_id, condition_id, unit_market)
    values (v_claim, v_tit.name, v_plat.name, v_ed.name, v_cond.name, v_cond.name, v_qty, round(v_unit * v_qty)::int, v_pos, v_ed.id, v_cond.id, v_unit);
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

-- ------------------------------------------------------------------
-- Curated catalog (pre-launch reset; no real claims reference editions yet).
-- base = Complete/CIB market value · loose_market / new_market = Loose / Sealed.
-- Values are sensible placeholders; the PriceCharting sync (price-sync) refreshes
-- them by title + console.
-- ------------------------------------------------------------------
delete from titles;  -- cascades to editions

insert into platforms (id, name, icon, position) values
  ('switch','Nintendo Switch','handheld',1),
  ('ps4','PlayStation 4','gamepad',2),
  ('xbox','Xbox One','gamepad',3)
on conflict (id) do update set name = excluded.name, icon = excluded.icon, position = excluded.position;

insert into titles (id, platform_id, name, position) values
  ('totk','switch','The Legend of Zelda: Tears of the Kingdom',1),
  ('botw','switch','The Legend of Zelda: Breath of the Wild',2),
  ('odyssey','switch','Super Mario Odyssey',3),
  ('mk8d','switch','Mario Kart 8 Deluxe',4),
  ('smash','switch','Super Smash Bros. Ultimate',5),
  ('acnh','switch','Animal Crossing: New Horizons',6),
  ('metroidd','switch','Metroid Dread',7),
  ('luigi3','switch','Luigi''s Mansion 3',8),
  ('xeno2','switch','Xenoblade Chronicles 2',9),
  ('gow','ps4','God of War',1),
  ('spiderman','ps4','Marvel''s Spider-Man',2),
  ('tlou2','ps4','The Last of Us Part II',3),
  ('bloodborne','ps4','Bloodborne',4),
  ('rdr2','ps4','Red Dead Redemption 2',5),
  ('ghost','ps4','Ghost of Tsushima',6),
  ('persona5r','ps4','Persona 5 Royal',7),
  ('witcher3','ps4','The Witcher 3: Wild Hunt',8),
  ('halomcc','xbox','Halo: The Master Chief Collection',1),
  ('forza4','xbox','Forza Horizon 4',2),
  ('rdr2x','xbox','Red Dead Redemption 2',3),
  ('gears5','xbox','Gears 5',4),
  ('seaofthieves','xbox','Sea of Thieves',5),
  ('oriwotw','xbox','Ori and the Will of the Wisps',6),
  ('cuphead','xbox','Cuphead',7),
  ('sunset','xbox','Sunset Overdrive',8);

insert into editions (title_id, edition_key, name, base, loose_market, new_market, description, position) values
  ('totk','std','Standard',48,40,55,null,1),
  ('botw','std','Standard',40,32,50,null,1),
  ('odyssey','std','Standard',40,33,48,null,1),
  ('mk8d','std','Standard',44,38,50,null,1),
  ('smash','std','Standard',48,42,55,null,1),
  ('acnh','std','Standard',42,34,48,null,1),
  ('metroidd','std','Standard',36,28,44,null,1),
  ('luigi3','std','Standard',40,32,47,null,1),
  ('xeno2','std','Standard',45,35,55,null,1),
  ('gow','std','Standard',15,11,22,null,1),
  ('spiderman','std','Standard',16,12,24,null,1),
  ('tlou2','std','Standard',17,13,24,null,1),
  ('bloodborne','std','Standard',17,13,26,null,1),
  ('rdr2','std','Standard',19,15,27,null,1),
  ('ghost','std','Standard',19,15,27,null,1),
  ('persona5r','std','Standard',28,22,38,null,1),
  ('witcher3','std','Standard',14,11,20,null,1),
  ('witcher3','goty','Game of the Year Edition',23,17,33,'Includes all expansions',2),
  ('halomcc','std','Standard',16,12,24,null,1),
  ('forza4','std','Standard',17,13,25,null,1),
  ('rdr2x','std','Standard',18,14,26,null,1),
  ('gears5','std','Standard',12,9,19,null,1),
  ('seaofthieves','std','Standard',15,11,23,null,1),
  ('oriwotw','std','Standard',23,17,31,null,1),
  ('cuphead','std','Standard',23,17,30,null,1),
  ('sunset','std','Standard',13,9,21,null,1);
