-- ===========================================================================
-- ShopWorks - Stripe
-- ===========================================================================
-- This is the database half of the Stripe work. It adds the columns that hold
-- what Stripe tells us, extends the guard so a shop cannot write any of them
-- itself, and teaches the app about a new in-between state: GRACE.
--
-- THE ONE NEW IDEA IN HERE IS GRACE.
-- Until now a shop was ok, on trial, or locked. A card that declines does not
-- fit any of those. Stripe will keep retrying for about two weeks, and locking
-- a good customer out on the morning their card expired is not the behaviour
-- you asked for. So there is now a fourth state:
--
--     active                              -> ok       (nothing shown)
--     trialing, trial not yet over        -> trial    (the trial banner)
--     past_due, inside the grace window   -> grace    (the red banner, app works)
--     anything else                       -> locked   (the locked screen)
--
-- The grace window is SEVEN DAYS from the first failed payment. During it the
-- app works normally, the shop's ADMIN sees a red banner with the date the app
-- will pause and a button to fix the card, and nobody else at that shop sees
-- anything at all. Same principle as the locked screen: another business's
-- payment trouble is not their crew's business and it is certainly not their
-- customers'.
--
-- ⚠️ WHO WRITES THESE COLUMNS. Nobody signed in, ever. The Stripe webhook
-- writes them using the service role key, which the guard deliberately does
-- not challenge, and you can write them in the Supabase dashboard. That is the
-- whole list. The guard from subscription-guard.sql is EXTENDED here to cover
-- the new columns - if it were not, we would have carefully locked the front
-- door and left nine new windows open.
--
-- ORDER: RUN THIS SQL FIRST, THEN DEPLOY THE CODE. Nothing live reads any of
-- these columns until the new code is up, so there is no window where the site
-- is half-changed.
--
-- ⚠️ RUN PART 1 AS ONE BLOCK. Section 1.4 drops my_shop_access() and puts it
-- straight back with one extra column. Run as a block, that happens inside a
-- single transaction and no running page ever sees it missing. (Even if it
-- did, the app treats "cannot answer" as "let them in" - but there is no
-- reason to lean on that.)
--
-- REHEARSED against a throwaway Postgres carrying your real policies, the real
-- guard trigger and a seeded MHC Fab, including the negative cases: every
-- check below was also run with its fix REMOVED, to prove it can actually fail.
-- ===========================================================================


-- ###########################################################################
-- ###  PART 1 - THE CHANGE.  Select 1.0 through 1.8 and run them together. ###
-- ###########################################################################

-- ---------------------------------------------------------------------------
-- 1.0 - Guard. Stop before touching anything if the ground is not what we
--       think it is.
-- ---------------------------------------------------------------------------
do $guard$
begin
  if to_regclass('public.companies') is null then
    raise exception 'ShopWorks: public.companies does not exist. Stopping.';
  end if;

  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='companies'
                    and column_name='subscription_status') then
    raise exception 'ShopWorks: run signup-trial-schema.sql first. Stopping.';
  end if;

  -- to_regprocedure, NOT to_regproc. to_regproc given a signature always
  -- returns null, which is how a guard like this once aborted a whole script
  -- on production. See signup-trial-build in the notes.
  if to_regprocedure('public.guard_subscription_columns()') is null then
    raise exception
      'ShopWorks: guard_subscription_columns() is missing - run subscription-guard.sql first. Stopping.';
  end if;

  if to_regclass('public.memberships') is null then
    raise exception 'ShopWorks: public.memberships does not exist. Stopping.';
  end if;
end
$guard$;


-- ---------------------------------------------------------------------------
-- 1.1 - What Stripe tells us, kept on the shop's own row.
--
-- Deliberately NOT one big json blob. Each of these is read by the app to make
-- a decision, and a column you can look at in the dashboard and understand at
-- a glance is worth more here than a faithful copy of Stripe's object.
--
-- plan_id is the band they ARE on. requested_plan (from plan-request.sql) is
-- the band they ASKED for before there was a checkout. They stay separate:
-- asking is not having, and the old column is what the pre-Stripe shops used.
-- ---------------------------------------------------------------------------
alter table public.companies
  add column if not exists stripe_customer_id text;

alter table public.companies
  add column if not exists stripe_subscription_id text;

alter table public.companies
  add column if not exists plan_id text;

alter table public.companies
  add column if not exists billing_interval text;

alter table public.companies
  add column if not exists current_period_end timestamptz;

alter table public.companies
  add column if not exists cancel_at_period_end boolean not null default false;

-- When a past_due shop runs out of rope. Set by the webhook on the first
-- failed payment, cleared the moment they pay.
alter table public.companies
  add column if not exists grace_ends_at timestamptz;

-- So you get told ONCE per lapse that a card failed, not once per Stripe
-- retry. Cleared alongside grace_ends_at when they pay.
alter table public.companies
  add column if not exists past_due_notified_at timestamptz;

-- ⚠️ THIS ONE COLUMN DECIDES WHO GETS A GRACE PERIOD.
-- Stamped the first time a shop's payment actually goes through, and never
-- cleared. A card that fails on a shop that has paid before starts the
-- seven-day clock; a card that fails on a shop that has NEVER paid is a free
-- trial ending on a card that will not go through, and that locks straight
-- away. Without this column the two cases are indistinguishable and a trial
-- would quietly become twenty-one days.
alter table public.companies
  add column if not exists first_paid_at timestamptz;


-- The same three band ids the code and the older column already use.
alter table public.companies
  drop constraint if exists companies_plan_id_check;

alter table public.companies
  add constraint companies_plan_id_check
  check (plan_id is null
         or plan_id in ('band_1_15','band_16_50','band_51_150'));

alter table public.companies
  drop constraint if exists companies_billing_interval_check;

alter table public.companies
  add constraint companies_billing_interval_check
  check (billing_interval is null
         or billing_interval in ('monthly','quarterly','semiannual','annual'));


-- Two shops must never end up pointing at the same Stripe customer or the same
-- Stripe subscription. If that ever happened, one shop's payment would switch
-- another shop on. Unique indexes make it impossible rather than unlikely.
create unique index if not exists companies_stripe_customer_id_key
  on public.companies (stripe_customer_id)
  where stripe_customer_id is not null;

create unique index if not exists companies_stripe_subscription_id_key
  on public.companies (stripe_subscription_id)
  where stripe_subscription_id is not null;


-- ---------------------------------------------------------------------------
-- 1.2 - Every Stripe message we have already dealt with.
--
-- Stripe will send the same event twice. It says so itself, and it is not a
-- fault - it is how it guarantees you get it at all. So the webhook writes the
-- event id here first, and a repeat simply collides on the primary key and is
-- ignored. Without this, a duplicated invoice.payment_failed would restart the
-- seven-day clock and a shop would get grace forever.
--
-- Nobody signed in can see or touch this table: row security is on and there
-- are NO policies, plus the grants are revoked. Only the service role, which
-- goes around row security by design, can write it. Same shape as the
-- shop_signups waiting room.
-- ---------------------------------------------------------------------------
create table if not exists public.stripe_events (
  id           text primary key,
  type         text not null,
  received_at  timestamptz not null default now()
);

alter table public.stripe_events enable row level security;

revoke all on public.stripe_events from public;
revoke all on public.stripe_events from anon;
revoke all on public.stripe_events from authenticated;


-- ---------------------------------------------------------------------------
-- 1.3 - THE GUARD, EXTENDED.
--
-- ⚠️ THIS IS THE MOST IMPORTANT SECTION IN THE FILE.
--
-- subscription-guard.sql stopped a signed-in person writing the five columns
-- that existed then. We have just added seven more, and every one of them is
-- load-bearing: stripe_subscription_id decides whose payment counts,
-- grace_ends_at decides when the app pauses, cancel_at_period_end decides what
-- the shop is told. Left unguarded, a locked shop could set its own
-- grace_ends_at to next Christmas with one ordinary API call.
--
-- The list below replaces the old one and contains all twelve.
--
-- ⚠️ STILL NOT security definer, for the same reason as before: this has to
-- see the role really doing the update. SECURITY DEFINER would hide it and the
-- guard would wave everything through.
-- ---------------------------------------------------------------------------
create or replace function public.guard_subscription_columns()
 returns trigger
 language plpgsql
as $function$
begin
  if current_user in ('authenticated', 'anon') then
    if new.subscription_status   is distinct from old.subscription_status
       or new.trial_ends_at        is distinct from old.trial_ends_at
       or new.locked_notified_at   is distinct from old.locked_notified_at
       or new.requested_plan       is distinct from old.requested_plan
       or new.plan_requested_at    is distinct from old.plan_requested_at
       -- added with Stripe:
       or new.stripe_customer_id     is distinct from old.stripe_customer_id
       or new.stripe_subscription_id is distinct from old.stripe_subscription_id
       or new.plan_id                is distinct from old.plan_id
       or new.billing_interval       is distinct from old.billing_interval
       or new.current_period_end     is distinct from old.current_period_end
       or new.cancel_at_period_end   is distinct from old.cancel_at_period_end
       or new.grace_ends_at          is distinct from old.grace_ends_at
       or new.past_due_notified_at   is distinct from old.past_due_notified_at
       or new.first_paid_at          is distinct from old.first_paid_at
    then
      raise exception
        'ShopWorks: the subscription is not yours to change.'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  -- Writing a column the value it already has is not a change, so it passes.
  -- That is correct: nothing moved. It is also what lets an ordinary Settings
  -- save go through untouched.
  return new;
end;
$function$;

-- The trigger itself is already there from subscription-guard.sql and points
-- at this function by name, so replacing the function is enough. Re-created
-- anyway so that running this file on a fresh database also works.
drop trigger if exists companies_guard_subscription on public.companies;

create trigger companies_guard_subscription
before update on public.companies
for each row execute function public.guard_subscription_columns();


-- ---------------------------------------------------------------------------
-- 1.4 - my_shop_access(), now with a grace state.
--
-- ⚠️ DROPPED AND RE-CREATED rather than replaced, because it hands back one
-- more column and Postgres will not let you change that with CREATE OR REPLACE.
-- Run as part of the whole block and this happens inside one transaction, so
-- no page ever sees it missing.
--
-- The state rules, in the order they are asked:
--   active                                        -> ok
--   trialing and the trial has not run out        -> trial
--   past_due and grace_ends_at is still ahead     -> grace
--   everything else                               -> locked
--
-- days_left now answers "days until the thing that is coming", which is the
-- end of the trial on a trial and the end of grace on a grace. The banner
-- shows the exact date from grace_ends_at rather than counting days, because
-- "the app pauses on Tuesday 17 March" is a sentence somebody acts on and
-- "4 days left" is one they scroll past.
--
-- ⚠️ It has to stay SECURITY DEFINER. companies_self_read requires
-- is_shop_user(), so a customer portal login cannot read its own shop's row at
-- all - and every portal page calls this. Returning no rows is how it says
-- "I cannot answer", and the app treats that as "let them in".
-- ---------------------------------------------------------------------------
drop function if exists public.my_shop_access();

create function public.my_shop_access()
 returns table (
   company_id          uuid,
   shop_name           text,
   role                text,
   state               text,
   subscription_status text,
   trial_ends_at       timestamptz,
   days_left           integer,
   grace_ends_at       timestamptz
 )
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return;
  end if;

  return query
  select c.id,
         c.name,
         p.role,
         case
           when c.subscription_status = 'active' then 'ok'
           when c.subscription_status = 'trialing'
                and (c.trial_ends_at is null or c.trial_ends_at > now()) then 'trial'
           when c.subscription_status = 'past_due'
                and c.grace_ends_at is not null
                and c.grace_ends_at > now() then 'grace'
           else 'locked'
         end,
         c.subscription_status,
         c.trial_ends_at,
         case
           when c.subscription_status = 'trialing' and c.trial_ends_at is not null
             then greatest(0, ceil(extract(epoch from (c.trial_ends_at - now())) / 86400.0))::integer
           when c.subscription_status = 'past_due' and c.grace_ends_at is not null
             then greatest(0, ceil(extract(epoch from (c.grace_ends_at - now())) / 86400.0))::integer
           else null
         end,
         c.grace_ends_at
    from public.profiles p
    join public.companies c on c.id = p.company_id
   where p.id = v_uid;
end;
$function$;


-- ---------------------------------------------------------------------------
-- 1.5 - claim_shop_lock_alert(), taught about grace.
--
-- Only change: a past_due shop that is still inside its grace window has NOT
-- hit the wall, so it must not stamp itself as "owner has been told they are
-- locked out". You get the card-failed email from the webhook instead, and the
-- locked-out email later only if it actually gets that far.
--
-- Everything else about it is unchanged, including the thing that matters
-- most: the stamp and the answer still happen in one statement, so two people
-- hitting the wall in the same second cannot both be told they were first.
-- ---------------------------------------------------------------------------
create or replace function public.claim_shop_lock_alert()
 returns table (
   should_send         boolean,
   shop_id             uuid,
   shop_name           text,
   subscription_status text,
   trial_ends_at       timestamptz
 )
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid     uuid := auth.uid();
  v_company uuid;
  v_stamped integer := 0;
begin
  if v_uid is null then
    return;
  end if;

  select p.company_id into v_company
    from public.profiles p
   where p.id = v_uid;

  if v_company is null then
    return;
  end if;

  update public.companies c
     set locked_notified_at = now()
   where c.id = v_company
     and c.locked_notified_at is null
     and (
       -- canceled is always the wall.
       c.subscription_status = 'canceled'
       -- past_due is only the wall once grace has run out.
       or (c.subscription_status = 'past_due'
           and (c.grace_ends_at is null or c.grace_ends_at <= now()))
       -- a trial that has run out is the wall.
       or (c.subscription_status = 'trialing'
           and c.trial_ends_at is not null
           and c.trial_ends_at <= now())
     );

  get diagnostics v_stamped = row_count;

  return query
  select v_stamped > 0,
         c.id,
         c.name,
         c.subscription_status,
         c.trial_ends_at
    from public.companies c
   where c.id = v_company;
end;
$function$;


-- ---------------------------------------------------------------------------
-- 1.6 - What the billing page is allowed to know.
--
-- my_shop_access() is called by every layout in the app, INCLUDING the
-- customer portal - so whatever it returns, a fabricator's customers can read
-- about that fabricator. That is why the Stripe detail is not in it. This
-- function answers the same question in more depth and refuses anybody who is
-- not that shop's admin, so the billing page can show the plan, the interval
-- and the renewal date without handing them to the shop's customers.
--
-- It deliberately does NOT return stripe_customer_id or stripe_subscription_id.
-- The page has no use for either; it only needs to know whether there is a
-- subscription to manage.
-- ---------------------------------------------------------------------------
create or replace function public.my_billing_summary()
 returns table (
   company_id           uuid,
   shop_name            text,
   subscription_status  text,
   trial_ends_at        timestamptz,
   grace_ends_at        timestamptz,
   plan_id              text,
   billing_interval     text,
   current_period_end   timestamptz,
   cancel_at_period_end boolean,
   has_subscription     boolean,
   requested_plan       text,
   plan_requested_at    timestamptz,
   login_count          integer
 )
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid     uuid := auth.uid();
  v_company uuid;
  v_role    text;
begin
  if v_uid is null then
    return;
  end if;

  select p.company_id, p.role into v_company, v_role
    from public.profiles p
   where p.id = v_uid;

  if v_company is null or v_role is distinct from 'admin' then
    return;
  end if;

  return query
  select c.id,
         c.name,
         c.subscription_status,
         c.trial_ends_at,
         c.grace_ends_at,
         c.plan_id,
         c.billing_interval,
         c.current_period_end,
         coalesce(c.cancel_at_period_end, false),
         c.stripe_subscription_id is not null,
         c.requested_plan,
         c.plan_requested_at,
         public.shop_login_count(c.id)
    from public.companies c
   where c.id = v_company;
end;
$function$;


-- ---------------------------------------------------------------------------
-- 1.7 - How many shop logins is this shop using?
--
-- This is the number the price bands are sold on, so it has to mean exactly
-- what the pricing page says it means: people at the SHOP who can log in,
-- admin and floor together. It counts live memberships, so somebody who has
-- been invited and has not set their password yet is counted (they have a
-- login), and somebody who has been asked to join a second shop and has not
-- answered is not (they have nothing here yet).
--
-- ⚠️ Customer portal logins are NOT counted and never should be. They are
-- unlimited and free, that is on the pricing page, and it is a promise.
-- They are excluded twice over - by role and by the memberships table only
-- ever holding shop people - because this is the kind of number that quietly
-- drifts into meaning something else.
--
-- Defined ahead of any caller so 1.6 above can use it.
-- ---------------------------------------------------------------------------
create or replace function public.shop_login_count(p_company uuid)
 returns integer
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select count(*)::integer
    from public.memberships m
   where m.company_id = p_company
     and m.status = 'active'
     and m.role in ('admin', 'employee');
$function$;


-- ---------------------------------------------------------------------------
-- 1.8 - Who may call what, and wake the API up.
--
-- shop_login_count takes a company id, so it is NOT handed to the app - a
-- signed-in person could ask it about somebody else's shop and learn how big
-- they are. It is called only from inside the two functions above, which work
-- out the company from the session themselves.
-- ---------------------------------------------------------------------------
revoke all on function public.shop_login_count(uuid)  from public, anon, authenticated;
revoke all on function public.my_shop_access()        from public, anon;
revoke all on function public.my_billing_summary()    from public, anon;
revoke all on function public.claim_shop_lock_alert() from public, anon;

grant execute on function public.my_shop_access()        to authenticated;
grant execute on function public.my_billing_summary()    to authenticated;
grant execute on function public.claim_shop_lock_alert() to authenticated;

notify pgrst, 'reload schema';
-- ⚠️ Wait about ten seconds after this before using the app.


-- ###########################################################################
-- ###  PART 2 - DID IT WORK?                                              ###
-- ###  Read-only apart from one write it puts back. Run it on its own,    ###
-- ###  AFTER part 1. Every line should say OK.                            ###
-- ###########################################################################
select 'the nine new columns are on companies' as check_name,
       case when (select count(*) from information_schema.columns
                   where table_schema='public' and table_name='companies'
                     and column_name in ('stripe_customer_id','stripe_subscription_id',
                                         'plan_id','billing_interval','current_period_end',
                                         'cancel_at_period_end','grace_ends_at',
                                         'past_due_notified_at','first_paid_at')) = 9
            then 'OK' else 'PROBLEM: expected 9 new columns' end as result

union all
select 'two shops cannot share a Stripe subscription',
       case when (select count(*) from pg_indexes
                   where schemaname='public' and tablename='companies'
                     and indexname in ('companies_stripe_customer_id_key',
                                       'companies_stripe_subscription_id_key')) = 2
            then 'OK' else 'PROBLEM: a unique index is missing' end

union all
select 'a junk band or interval cannot be stored',
       case when (select count(*) from pg_constraint
                   where conname in ('companies_plan_id_check',
                                     'companies_billing_interval_check')) = 2
            then 'OK' else 'PROBLEM: a check constraint is missing' end

union all
select 'the repeat-event table exists and is locked down',
       case when to_regclass('public.stripe_events') is not null
             and (select relrowsecurity from pg_class where oid='public.stripe_events'::regclass)
             and (select count(*) from pg_policies
                   where schemaname='public' and tablename='stripe_events') = 0
             and not has_table_privilege('authenticated','public.stripe_events','select')
            then 'OK - only the webhook can touch it'
            else 'PROBLEM: stripe_events is readable or missing' end

union all
select 'my_shop_access hands back the grace date',
       case when (select count(*) from information_schema.routines r
                   join information_schema.parameters p
                     on p.specific_name = r.specific_name
                  where r.routine_schema='public' and r.routine_name='my_shop_access'
                    and p.parameter_name = 'grace_ends_at') = 1
            then 'OK' else 'PROBLEM: my_shop_access was not replaced' end

union all
select 'the billing summary is in, and pinned',
       case when (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                   where n.nspname='public' and p.proname='my_billing_summary'
                     and p.prosecdef and p.proconfig::text like '%search_path%') = 1
            then 'OK' else 'PROBLEM' end

union all
select 'the login counter is NOT callable from the app',
       case when (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                   where n.nspname='public' and p.proname='shop_login_count'
                     and (has_function_privilege('authenticated', p.oid, 'execute')
                          or has_function_privilege('anon', p.oid, 'execute'))) = 0
            then 'OK - it cannot be asked about another shop'
            else 'PROBLEM: authenticated or anon can call shop_login_count' end

union all
select 'nobody was accidentally put on a Stripe plan',
       case when (select count(*) from public.companies
                   where stripe_subscription_id is not null or plan_id is not null) = 0
            then 'OK' else 'PROBLEM: a shop already has a subscription recorded' end

union all
select 'MHC Fab is still active and untouched',
       case when (select subscription_status from public.companies
                   where id = '86aecd1e-d42c-43c0-976d-44189c1eb1b9') = 'active'
             and (select grace_ends_at from public.companies
                   where id = '86aecd1e-d42c-43c0-976d-44189c1eb1b9') is null
            then 'OK' else 'PROBLEM' end;


-- ###########################################################################
-- ###  PART 3 - PROVE THE GUARD ACTUALLY GUARDS THE NEW COLUMNS.          ###
-- ###  Run this on its own, after PART 2.                                 ###
-- ###########################################################################
-- ⚠️ THIS IS THE CHECK THAT MATTERS, AND IT IS THE ONE THAT CAUGHT THE HOLE
-- LAST TIME. It does not ask the database whether it THINKS the columns are
-- protected - that question gave the wrong answer once already and cost a day.
-- It becomes the signed-in role, signs in as your own admin login, and
-- actually attempts the write a locked shop would attempt.
--
-- Safe on production: it touches only grace_ends_at on MHC Fab, puts back
-- whatever was there, and if the guard has failed the error rolls the attempt
-- back so nothing is left changed either way.
--
-- You want the NOTICE that starts "OK".
do $test$
declare
  v_admin   uuid;
  v_before  timestamptz;
  v_after   timestamptz;
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

  select grace_ends_at into v_before from public.companies where id = v_mhc;

  begin
    set local role authenticated;
    perform set_config('request.jwt.claims',
                       json_build_object('sub', v_admin, 'role', 'authenticated')::text,
                       true);
    -- This is the attack: give myself a year of grace.
    update public.companies
       set grace_ends_at = now() + interval '365 days'
     where id = v_mhc;
  exception when others then
    v_blocked := true;
  end;

  reset role;
  perform set_config('request.jwt.claims', '', true);

  select grace_ends_at into v_after from public.companies where id = v_mhc;

  -- Put it back whatever happened.
  update public.companies set grace_ends_at = v_before where id = v_mhc;

  if v_blocked and v_after is not distinct from v_before then
    raise notice 'OK - the app was refused, and nothing about MHC Fab changed';
  else
    raise exception
      'PROBLEM - the app wrote grace_ends_at (before=%, after=%, blocked=%)',
      coalesce(v_before::text,'null'), coalesce(v_after::text,'null'), v_blocked;
  end if;
end
$test$;


-- ###########################################################################
-- ###  PART 4 - AND PROVE AN ORDINARY SETTINGS SAVE STILL WORKS.          ###
-- ###  Run this on its own, after PART 3.                                 ###
-- ###########################################################################
-- A guard that blocks everything would pass PART 3 and break your Settings
-- page. This proves it does not: same admin, same signed-in role, writing a
-- column they are entitled to write.
do $test$
declare
  v_admin   uuid;
  v_before  numeric;
  v_ok      boolean := true;
  v_mhc     uuid := '86aecd1e-d42c-43c0-976d-44189c1eb1b9';
begin
  select p.id into v_admin
    from public.profiles p
   where p.company_id = v_mhc and p.role = 'admin' and p.is_active
   order by p.created_at
   limit 1;

  select burden_rate_per_hour into v_before from public.companies where id = v_mhc;

  begin
    set local role authenticated;
    perform set_config('request.jwt.claims',
                       json_build_object('sub', v_admin, 'role', 'authenticated')::text,
                       true);
    update public.companies
       set burden_rate_per_hour = coalesce(v_before, 0)
     where id = v_mhc;
  exception when others then
    v_ok := false;
  end;

  reset role;
  perform set_config('request.jwt.claims', '', true);

  update public.companies set burden_rate_per_hour = v_before where id = v_mhc;

  if v_ok then
    raise notice 'OK - your Settings page still saves';
  else
    raise exception 'PROBLEM - the guard is blocking an ordinary settings save';
  end if;
end
$test$;


-- ---------------------------------------------------------------------------
-- WHEN A SHOP PAYS - you should never need this again.
--
-- Stripe now does this by itself through the webhook. It is kept only for the
-- case where you take money some other way (a cheque, a design partner you are
-- billing by hand) and want to switch a shop on without a Stripe subscription.
-- ---------------------------------------------------------------------------
/*
update public.companies
   set subscription_status  = 'active',
       trial_ends_at        = null,
       grace_ends_at        = null,
       locked_notified_at   = null,   -- re-arms the lock alert for a future lapse
       past_due_notified_at = null,   -- re-arms the card-failed alert
       requested_plan       = null,
       plan_requested_at    = null
       -- first_paid_at is deliberately NOT touched. It is a historical fact,
       -- and clearing it would take away a real customer's grace period the
       -- next time their card hiccuped.
 where name = 'THE SHOP NAME';
*/


-- ---------------------------------------------------------------------------
-- UNDO, if this ever needs to come back out.
--
-- ⚠️ Restoring the OLD guard function is the first line for a reason. Dropping
-- the columns without it leaves a guard that refers to columns that no longer
-- exist, and every single Settings save on every shop starts failing.
-- ---------------------------------------------------------------------------
/*
create or replace function public.guard_subscription_columns()
 returns trigger language plpgsql
as $undo$
begin
  if current_user in ('authenticated', 'anon') then
    if new.subscription_status is distinct from old.subscription_status
       or new.trial_ends_at      is distinct from old.trial_ends_at
       or new.locked_notified_at is distinct from old.locked_notified_at
       or new.requested_plan     is distinct from old.requested_plan
       or new.plan_requested_at  is distinct from old.plan_requested_at then
      raise exception 'ShopWorks: the subscription is not yours to change.'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$undo$;

drop function if exists public.my_billing_summary();
drop function if exists public.shop_login_count(uuid);
drop table if exists public.stripe_events;

alter table public.companies drop constraint if exists companies_plan_id_check;
alter table public.companies drop constraint if exists companies_billing_interval_check;
drop index if exists public.companies_stripe_customer_id_key;
drop index if exists public.companies_stripe_subscription_id_key;

alter table public.companies drop column if exists first_paid_at;
alter table public.companies drop column if exists past_due_notified_at;
alter table public.companies drop column if exists grace_ends_at;
alter table public.companies drop column if exists cancel_at_period_end;
alter table public.companies drop column if exists current_period_end;
alter table public.companies drop column if exists billing_interval;
alter table public.companies drop column if exists plan_id;
alter table public.companies drop column if exists stripe_subscription_id;
alter table public.companies drop column if exists stripe_customer_id;

-- and my_shop_access() back to its 7-column form from signup-trial-schema.sql
notify pgrst, 'reload schema';
*/
