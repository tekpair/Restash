-- Restash — Digital Card payout (store credit + 25% bonus).
--
-- Opt-in payout: instead of cash, the seller takes the value as a digital gift
-- card for a chosen platform (PlayStation / Xbox / Nintendo) and gets 25% more.
-- Choosing it WAIVES the right to negotiate the inspected offer, so the offer
-- is auto-credited (no customer accept step). The inspected amount is rounded
-- UP to the next $5, then the 25% bonus is added (e.g. $19 -> $20 -> $25). The
-- balance is store credit only (never withdrawable cash) and resets monthly.
--
-- LEGAL: gift-card expiry and held balances have real nuance (state gift-card,
-- unclaimed-property / escheatment, and CARD Act rules). Have an attorney
-- review the expiry + forfeiture terms before launch.

-- 1. Columns -------------------------------------------------------------
alter table claims
  add column if not exists card_brand text
    check (card_brand is null or card_brand in ('PlayStation','Xbox','Nintendo'));

-- 2. The credit math (shared by the RPCs below). ------------------------
create or replace function public.card_credit(p_offer numeric)
returns integer
language sql
immutable
as $$
  -- round the inspected offer up to the next $5, then add 25%, whole dollars
  select ceil( (ceil(coalesce(p_offer, 0) / 5.0) * 5) * 1.25 )::int;
$$;

-- 3. submit_claim now takes the chosen card brand. Re-create with the extra
-- parameter (the customer app passes p_card_brand; null for PayPal/Check).
-- NOTE: keep the body in sync with 0003_rpcs.sql — this only adds the brand.
-- (Shown here as the canonical signature for the Digital Card feature.)
--   create or replace function public.submit_claim(
--     p_items jsonb, p_payout text, p_phone text, p_address text,
--     p_notes text, p_card_brand text) ...
--   * validates: if p_payout = 'Digital Card' then p_card_brand must be set
--   * stores claims.card_brand = p_card_brand

-- 4. make_offer auto-finalizes a Digital Card claim (seller waived
-- negotiation): instead of moving to 'offer' (awaiting the customer), it
-- credits card_credit(amount) and goes straight to 'paid'.
--   if (select payout from claims where ref = p_ref) = 'Digital Card' then
--     update claims set status='paid', offer_amount=p_amount,
--       customer_response='accepted', paid_amount=public.card_credit(p_amount),
--       paid_method='Digital Card (' || card_brand || ')' where ref = p_ref;
--     -- history: 'Offer made: $X -> digital card $Y (+25% bonus)'
--   else  ... existing customer-gated offer path ...
--   end if;

revoke all on function public.card_credit(numeric) from anon;
