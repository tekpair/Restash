-- Restash — seed data (catalog + team). Idempotent; re-running updates values.
-- NOTE: buyback values are the prototype placeholders. Replace with real
-- numbers (e.g. PriceCharting comps x your buyback rate) before launch.

insert into platforms (id, name, icon, position) values
  ('switch','Nintendo Switch','handheld',1),
  ('ps4','PlayStation 4','gamepad',2),
  ('xbox','Xbox One','gamepad',3)
on conflict (id) do update set name = excluded.name, icon = excluded.icon, position = excluded.position;

insert into titles (id, platform_id, name, position) values
  ('mk8d','switch','Mario Kart 8 Deluxe',1),
  ('smash','switch','Super Smash Bros. Ultimate',2),
  ('totk','switch','The Legend of Zelda: Tears of the Kingdom',3),
  ('odyssey','switch','Super Mario Odyssey',4),
  ('gow','ps4','God of War',1),
  ('witcher','ps4','The Witcher 3: Wild Hunt',2),
  ('rdr2','ps4','Red Dead Redemption 2',3),
  ('spider','ps4','Marvel''s Spider-Man',4),
  ('halomcc','xbox','Halo: The Master Chief Collection',1),
  ('forza4','xbox','Forza Horizon 4',2),
  ('rdr2x','xbox','Red Dead Redemption 2',3),
  ('gtav','xbox','Grand Theft Auto V',4)
on conflict (id) do update set platform_id = excluded.platform_id, name = excluded.name, position = excluded.position;

insert into editions (title_id, edition_key, name, base, description, position) values
  ('mk8d','std','Standard',28,null,1),
  ('smash','std','Standard',26,null,1),
  ('totk','std','Standard',30,null,1),
  ('odyssey','std','Standard',24,null,1),
  ('gow','std','Standard',12,null,1),
  ('gow','hits','PS Hits (reprint)',8,'Budget re-release — lower value',2),
  ('witcher','std','Standard',10,null,1),
  ('witcher','goty','Game of the Year Edition',18,'Includes all expansions',2),
  ('rdr2','std','Standard',14,null,1),
  ('spider','std','Standard',13,null,1),
  ('halomcc','std','Standard',11,null,1),
  ('forza4','std','Standard',14,null,1),
  ('rdr2x','std','Standard',12,null,1),
  ('gtav','std','Standard',10,null,1)
on conflict (title_id, edition_key) do update set name = excluded.name, base = excluded.base,
  description = excluded.description, position = excluded.position;

insert into conditions (id, name, mult, description, ineligible, icon, position) values
  ('sealed','Brand New (Sealed)',1.40,'Factory sealed, never opened',false,'box',1),
  ('complete','Complete',1.00,'Case, cover art, inserts, and a clean disc or cart',false,'gamecase',2),
  ('loose','Game Only (Loose)',0.60,'Disc or cart only — no case or artwork',false,'disc',3),
  ('broken','Not Working / Counterfeit',0.00,'Won''t play, cracked, or a reproduction',true,'xcircle',4)
on conflict (id) do update set name = excluded.name, mult = excluded.mult, description = excluded.description,
  ineligible = excluded.ineligible, icon = excluded.icon, position = excluded.position;

-- Team directory (console Team tab). Insert once, keyed by email.
insert into team_members (group_name, name, role, email, location, focus, description, position)
select * from (values
  ('Founders','Connor Waugaman','Co-Founder & Operations','connor@getrestash.gg','Cohoes, NY',
   array['Buyback pricing','Claim review','Payouts'],
   'Runs Restash day to day — sets the buyback pricing, reviews flagged and edge-case claims, and signs off on every payout.',1),
  ('Founders','Kamryn Washington','Co-Founder & Intake / Inspection','kamryn@getrestash.gg','Cohoes, NY',
   array['Intake','Condition grading','Counterfeit checks'],
   'Handles games once they arrive — receives shipments, grades condition, and flags counterfeit or non-working copies.',2)
) as t(group_name,name,role,email,location,focus,description,position)
where not exists (select 1 from team_members tm where tm.email = t.email);
