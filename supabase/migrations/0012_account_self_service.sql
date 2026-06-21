-- Restash — customer self-service: request a copy of their information, and
-- delete their own account. Both are SECURITY DEFINER and scoped to the
-- authenticated caller (auth.uid()); the client can only act on itself.

-- CUSTOMER: log a request for a copy of their information. We fulfill data
-- requests manually (per the Privacy Policy), so this records the request as
-- an account note that staff see on the account in the console.
create or replace function public.request_data_export()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  insert into account_notes (profile_id, body, author_id, author_name)
  values (v_uid, 'Customer requested a copy of their information.', null, 'System');
end;
$$;

-- CUSTOMER: permanently delete their own account. Deleting the auth user
-- cascades to the profile (profiles.id references auth.users on delete
-- cascade) and on to their claims, items, history, and notes.
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  delete from auth.users where id = v_uid;
end;
$$;

-- Only authenticated users may call these.
revoke all on function public.request_data_export() from anon;
revoke all on function public.delete_my_account()    from anon;
