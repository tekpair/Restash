-- Restash — schema
-- Customer + staff share one Postgres database. Access is enforced with
-- Row-Level Security (see 0002_security.sql); pricing and the claim
-- lifecycle are enforced with SECURITY DEFINER functions (see 0003_rpcs.sql).

create extension if not exists pgcrypto;   -- gen_random_uuid()

-- ------------------------------------------------------------------
-- Catalog (buyback values live here, not in client code)
-- ------------------------------------------------------------------
create table if not exists platforms (
  id        text primary key,           -- e.g. 'switch'
  name      text not null,              -- 'Nintendo Switch'
  icon      text not null default 'gamepad',
  position  int  not null default 0
);

create table if not exists titles (
  id          text primary key,         -- e.g. 'mk8d'
  platform_id text not null references platforms(id) on delete cascade,
  name        text not null,
  position    int  not null default 0
);

create table if not exists editions (
  id          uuid primary key default gen_random_uuid(),
  title_id    text not null references titles(id) on delete cascade,
  edition_key text not null,            -- 'std', 'goty', 'hits' (unique per title)
  name        text not null,
  base        int  not null,            -- buyback value for "Complete"
  description text,
  position    int  not null default 0,
  unique (title_id, edition_key)
);

create table if not exists conditions (
  id          text primary key,         -- 'sealed','complete','loose','broken'
  name        text not null,
  mult        numeric(4,2) not null,    -- multiplier applied to edition base
  description text,
  ineligible  boolean not null default false,
  icon        text not null default 'gamecase',
  position    int  not null default 0
);

-- ------------------------------------------------------------------
-- People
-- ------------------------------------------------------------------
-- One row per auth user. Created automatically on signup (trigger in 0002).
create table if not exists profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  full_name  text not null default '',
  email      text not null default '',  -- mirrored from auth for staff search
  phone      text not null default '',
  address    text not null default '',  -- mailing address (for checks)
  role       text not null default 'customer' check (role in ('customer','staff')),
  flagged    boolean not null default false,
  created_at timestamptz not null default now()
);

-- Staff directory shown on the console Team tab (display cards; distinct
-- from auth users — a person can appear here without a login, and vice versa).
create table if not exists team_members (
  id          uuid primary key default gen_random_uuid(),
  group_name  text not null,
  name        text not null,
  role        text not null,
  email       text not null default '',
  location    text not null default '',
  focus       text[] not null default '{}',
  description text not null default '',
  position    int not null default 0
);

-- ------------------------------------------------------------------
-- Claims
-- ------------------------------------------------------------------
create table if not exists claims (
  id                uuid primary key default gen_random_uuid(),
  ref               text not null unique,            -- RS-XXXXXX
  customer_id       uuid not null references profiles(id) on delete cascade,
  -- snapshot of the customer at submission (payouts are name-matched to this)
  cust_name         text not null,
  cust_email        text not null,
  cust_phone        text not null default '',
  est_low           int  not null,
  est_high          int  not null,
  payout            text not null check (payout in ('PayPal','Check')),
  address           text not null default '',        -- mailing address for checks
  customer_notes    text not null default '',
  status            text not null default 'submitted'
                      check (status in ('submitted','reviewing','accepted','received','offer','paid','declined','returned')),
  offer_amount      int,
  customer_response text check (customer_response in ('accepted','declined')),
  assignee_id       uuid references profiles(id) on delete set null,
  assignee_name     text,
  flagged           boolean not null default false,
  -- payout ledger (manual payouts: staff records when money actually goes out)
  paid_amount       int,
  paid_method       text,
  paid_at           timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists claims_customer_idx on claims(customer_id);
create index if not exists claims_status_idx   on claims(status);

create table if not exists claim_items (
  id            uuid primary key default gen_random_uuid(),
  claim_id      uuid not null references claims(id) on delete cascade,
  title_name    text not null,
  platform_name text not null,
  edition_name  text not null,
  cond_name     text not null,
  qty           int  not null check (qty > 0),
  line_mid      int  not null,
  position      int  not null default 0
);
create index if not exists claim_items_claim_idx on claim_items(claim_id);

-- Customer-visible status timeline
create table if not exists claim_history (
  id         uuid primary key default gen_random_uuid(),
  claim_id   uuid not null references claims(id) on delete cascade,
  label      text not null,
  note       text,
  created_at timestamptz not null default now()
);
create index if not exists claim_history_claim_idx on claim_history(claim_id);

-- Internal staff-only notes on a claim
create table if not exists claim_notes (
  id          uuid primary key default gen_random_uuid(),
  claim_id    uuid not null references claims(id) on delete cascade,
  body        text not null,
  author_id   uuid references profiles(id) on delete set null,
  author_name text not null default '',
  created_at  timestamptz not null default now()
);
create index if not exists claim_notes_claim_idx on claim_notes(claim_id);

-- Internal staff-only notes on a customer account
create table if not exists account_notes (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references profiles(id) on delete cascade,
  body        text not null,
  author_id   uuid references profiles(id) on delete set null,
  author_name text not null default '',
  created_at  timestamptz not null default now()
);
create index if not exists account_notes_profile_idx on account_notes(profile_id);
