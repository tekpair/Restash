-- Restash — customer-facing reasons on staff decisions.
-- Staff can attach a plain-language reason to an offer, a decline, or a
-- post-inspection rejection. The reason is written to claim_history.note,
-- which is visible to the customer (RLS lets them read their own history),
-- so they can see *why*. Internal-only context still goes in claim_notes.

-- make_offer now takes an optional customer-facing reason ------------------
drop function if exists public.make_offer(text, int);
create or replace function public.make_offer(p_ref text, p_amount int, p_reason text default '')
returns void
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
  -- reason (if given) becomes the customer-visible note on the offer
  perform _push_history(c.id, 'Offer made: $' || p_amount, nullif(trim(p_reason), ''));
end; $$;

-- decline_claim (pre-inspection) now takes an optional reason --------------
drop function if exists public.decline_claim(text);
create or replace function public.decline_claim(p_ref text, p_reason text default '')
returns void
language plpgsql security definer set search_path = public as $$
declare c claims := _claim_for_staff(p_ref);
begin
  if c.status not in ('submitted','reviewing') then raise exception 'Claim is not pending review'; end if;
  update claims set status = 'declined', updated_at = now() where id = c.id;
  perform _push_history(c.id, 'Declined — not accepted',
    coalesce(nullif(trim(p_reason), ''), 'We weren''t able to accept this claim this cycle.'));
end; $$;

-- reject_return (post-inspection) now takes an optional reason -------------
drop function if exists public.reject_return(text);
create or replace function public.reject_return(p_ref text, p_reason text default '')
returns void
language plpgsql security definer set search_path = public as $$
declare c claims := _claim_for_staff(p_ref);
begin
  if c.status <> 'received' then raise exception 'Claim is not in inspection'; end if;
  update claims set status = 'returned', updated_at = now() where id = c.id;
  perform _push_history(c.id, 'Rejected on inspection — returning to seller',
    coalesce(nullif(trim(p_reason), ''), 'We''ll email tracking.'));
end; $$;
