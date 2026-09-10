-- ===========================================================================
-- ShopWorks - stop a shop switching its own subscription back on
-- ===========================================================================
-- ⚠️ THIS REPLACES PART 3 OF plan-request.sql, WHICH DID NOT WORK.
--
-- WHAT HAPPENED
-- PART 3 tried to take a privilege away: revoke UPDATE on `companies` from the
-- signed-in role, then grant it back one column at a time. Its own check said:
--
--     the subscription columns are NOT writable ... PROBLEM
--
-- The reason is a Supabase detail. The blanket table privileges were granted
-- by `supabase_admin`, and the `postgres` role you run SQL as is not that role.
-- Postgres does not raise an error on a REVOKE it cannot perform - it shrugs
-- and moves on. So the revoke did nothing, the column grants underneath it were
-- never reached, and the hole stayed open. The check is the only reason we know.
--
-- ⚠️ You do NOT need to undo PART 3. While the table-level grant is still there,
-- the extra column grants it added are simply redundant. Leave them.
--
-- WHAT THIS DOES INSTEAD
-- It does not try to take anything away. It puts a guard on the table, and the
-- guard asks WHO is making the change:
--
--     the app, as a signed-in person  ->  refused
--     you, in the Supabase dashboard  ->  allowed
--     our own functions (request_plan,
--     claim_shop_lock_alert)          ->  allowed
--
-- That last line is why this works: a SECURITY DEFINER function runs as its
-- owner rather than as the person who called it, so the guard can tell "the app
-- asked directly" from "our code did it on the app's behalf".
--
-- Nothing a shop is entitled to change is affected - names, rates, markup and
-- every inventory toggle still save exactly as before.
--
-- ⚠️ REHEARSED ON A DATABASE DELIBERATELY SET UP THE WAY YOURS ACTUALLY IS,
-- with the blanket grant still in place - so it was proven in the situation
-- PART 3 failed in, not in a clean one. The check at the bottom was also run
-- with the guard REMOVED, to be sure it can actually fail.
--
-- ORDER: run PART 1 first, then PART 2 on its own.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- PART 1 - THE GUARD
-- ---------------------------------------------------------------------------
create or replace function public.guard_subscription_columns()
 returns trigger
 language plpgsql
as $function$
begin
  -- NOT security definer, deliberately. This has to see the role that is
  -- really doing the update; SECURITY DEFINER would hide it and the guard
  -- would let everything through.
  if current_user in ('authenticated', 'anon') then
    if new.subscription_status is distinct from old.subscription_status
       or new.trial_ends_at      is distinct from old.trial_ends_at
       or new.locked_notified_at is distinct from old.locked_notified_at
       or new.requested_plan     is distinct from old.requested_plan
       or new.plan_requested_at  is distinct from old.plan_requested_at then
      raise exception
        'ShopWorks: the subscription is not yours to change.'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  -- Writing a column the value it already has is not a change, so it passes.
  -- That is correct: nothing moved.
  return new;
end;
$function$;

drop trigger if exists companies_guard_subscription on public.companies;

create trigger companies_guard_subscription
before update on public.companies
for each row execute function public.guard_subscription_columns();

notify pgrst, 'reload schema';


-- ---------------------------------------------------------------------------
-- PART 2 - DID IT WORK? Run this on its own, AFTER part 1.
--
-- This does not ask the database about permissions - that is what misled us
-- last time. It becomes the signed-in role, signs in AS YOUR OWN ADMIN LOGIN,
-- and actually attempts the write a locked shop would attempt.
--
-- It is safe on production: it touches only the `requested_plan` column on MHC
-- Fab, puts back whatever was there, and if the guard has failed the whole
-- thing is rolled back by the error so nothing is left changed either way.
--
-- You want the NOTICE that starts "OK".
-- ---------------------------------------------------------------------------
do $test$
declare
  v_admin   uuid;
  v_before  text;
  v_after   text;
  v_blocked boolean := false;
  v_mhc     uuid := '86aecd1e-d42c-43c0-976d-44189c1eb1b9';
begin
  select p.id into v_admin
    from public.profiles p
   where p.company_id = v_mhc and p.role = 'admin' and p.is_active
   order by p.created_at
   limit 1;

  if v_admin is null then
    raise exception 'PROBLEM - no admin found at MHC Fab to test with';
  end if;

  select requested_plan into v_before from public.companies where id = v_mhc;

  begin
    set local role authenticated;
    perform set_config('request.jwt.claims',
                       json_build_object('sub', v_admin, 'role', 'authenticated')::text,
                       true);
    update public.companies set requested_plan = 'band_1_15' where id = v_mhc;
  exception when others then
    v_blocked := true;
  end;

  reset role;
  perform set_config('request.jwt.claims', '', true);

  select requested_plan into v_after from public.companies where id = v_mhc;

  -- put it back whatever happened
  update public.companies set requested_plan = v_before where id = v_mhc;

  if v_blocked and v_after is not distinct from v_before then
    raise notice 'OK - the app was refused, and nothing about MHC Fab changed';
  else
    raise exception
      'PROBLEM - the app wrote a subscription column (before=%, after=%, blocked=%)',
      coalesce(v_before, 'null'), coalesce(v_after, 'null'), v_blocked;
  end if;
end
$test$;


-- ---------------------------------------------------------------------------
-- UNDO, if this ever gets in the way
-- ---------------------------------------------------------------------------
/*
drop trigger if exists companies_guard_subscription on public.companies;
drop function if exists public.guard_subscription_columns();
notify pgrst, 'reload schema';
*/
