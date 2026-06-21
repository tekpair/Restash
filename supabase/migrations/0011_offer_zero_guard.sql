-- Restash — block offers on a claim with no eligible value.
-- When every game is graded ineligible (Not Working / Counterfeit), the
-- assessed value is $0. Making an offer is nonsensical there — staff should
-- Reject & return instead. Without this, the band collapses to $1–$1 and the
-- offer form dead-ends.

create or replace function public.make_offer(p_ref text, p_amount int, p_reason text default '')
returns void language plpgsql security definer set search_path = public as $$
declare c claims := _claim_for_staff(p_ref); v_sugg int; v_lo int; v_hi int;
begin
  if c.status <> 'received' then raise exception 'Can only offer on a received claim'; end if;
  v_sugg := compute_offer(c.id);
  if v_sugg <= 0 then
    raise exception 'This claim has no eligible value — reject and return it instead.';
  end if;
  v_lo := greatest(1, floor(v_sugg * 0.85)::int);
  v_hi := greatest(v_lo, ceil(v_sugg * 1.15)::int);
  if p_amount is null or p_amount < v_lo or p_amount > v_hi then
    raise exception 'Offer must be between $% and $% for this claim (algorithm suggests $%)', v_lo, v_hi, v_sugg;
  end if;
  update claims set status='offer', offer_amount=p_amount, customer_response=null, updated_at=now() where id = c.id;
  perform _push_history(c.id, 'Offer made: $' || p_amount, nullif(trim(p_reason),''));
end; $$;
