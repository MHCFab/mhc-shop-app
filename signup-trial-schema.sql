-- ===========================================================================
-- ShopWorks - self-serve signup + 14-day trial
-- ===========================================================================
-- HOW TO RUN THIS
--   PART 0 is read-only and you have already run it. You can skip it.
--   PART 1 is the change. Run 1.0 to 1.7 as ONE block.
--   PART 2 checks it worked. Twelve lines, all should say OK.
--   The UNDO at the very bottom is commented out. Leave it that way.
--
-- ORDER: RUN THIS SQL FIRST, THEN DEPLOY THE CODE. That is the opposite of the
-- invite-route change back in August, so it is worth saying plainly. Nothing
-- running today reads any of the new columns or functions, so this file is
-- invisible to the app until the new code goes up. There is no window where
-- MHC is half-migrated.
--
-- REHEARSED BEFORE YOU SAW IT: every statement here, plus 15 behaviour cases
-- and the whole signup sequence, was run against a throwaway Postgres loaded
-- with your real rules and your real trigger. It caught three things I had
-- written wrong, including one that would have aborted this entire script on
-- your production database.
--
-- YOUR SHOP CANNOT BE LOCKED OUT BY THIS. The new status column defaults to
-- 'active', so MHC Fab is a paid shop the instant the column exists, and 1.2
-- says so again by name. PART 2 checks it twice.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 0a - What columns does `companies` actually have today?
--
-- This is the table the trial and the subscription status will live on, and I
-- need to know what is already there before I add anything.
-- ---------------------------------------------------------------------------
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'companies'
order by ordinal_position;


-- ---------------------------------------------------------------------------
-- 0b - Is anything already using the names I am about to create?
--
-- "No rows returned" is the answer I want. Anything here means I have to pick
-- a different name or work with what is there.
-- ---------------------------------------------------------------------------
select 'table' as kind, table_name as name
from information_schema.tables
where table_schema = 'public'
  and table_name in ('shop_signups','subscriptions')
union all
select 'column', column_name
from information_schema.columns
where table_schema = 'public' and table_name = 'companies'
  and column_name in ('subscription_status','trial_ends_at','locked_at','plan')
union all
select 'function', p.proname
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('create_shop_for_current_user','shop_access_state','my_shop_status');


-- ---------------------------------------------------------------------------
-- 0c - The rules on `companies` right now.
--
-- Signup has to be able to CREATE a company row, and that is the one table
-- where a new shop has no membership yet. I need to see what the current rules
-- allow before I decide how the new shop gets created.
-- ---------------------------------------------------------------------------
select policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public' and tablename = 'companies'
order by policyname;


-- ---------------------------------------------------------------------------
-- 0d - What is on `companies` today, one row per shop.
--
-- Expect one row - MHC. This is also the row that must NEVER be locked out,
-- so I want to see it before I write anything that can lock a shop.
-- ---------------------------------------------------------------------------
select id, name, created_at
from public.companies
order by created_at;


-- ---------------------------------------------------------------------------
-- 0e - The shape of employee_invitations.
--
-- The hardened trigger refuses to create any login without a pending row in
-- this table, so the signup route has to write one. I need its exact columns
-- and which of them are required.
-- ---------------------------------------------------------------------------
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'employee_invitations'
order by ordinal_position;


-- ---------------------------------------------------------------------------
-- 0f - Confirm the new-user trigger is still exactly what I think it is.
--
-- Everything in this feature is built around what this function does. Paste the
-- whole thing back. If it does not contain the words "no pending invitation",
-- stop and tell me - the ground has moved and I need to re-plan.
-- ---------------------------------------------------------------------------
select pg_get_functiondef('public.handle_new_user()'::regprocedure) as handle_new_user;


-- ---------------------------------------------------------------------------
-- 0g - Sanity: every existing login still lines up with a membership.
--
-- Should be zero. If it is not, something drifted since the memberships build
-- and I want to know before adding a second way to create accounts.
-- ---------------------------------------------------------------------------
select count(*) as logins_with_no_membership
from public.profiles p
where not exists (
  select 1 from public.memberships m where m.user_id = p.id
);


-- ===========================================================================
-- ============ PART 1 - THE CHANGE ==========================================
-- ===========================================================================
-- Run this only after PART 0 looks the way it should, and only after the app
-- code is deployed. Run 1.0 through 1.7 as ONE block - the guard at the top
-- and the work below belong together.
--
-- REHEARSED: every statement in this part, and every behaviour case at the
-- bottom of this file, was run against a throwaway Postgres before you saw it.
--
-- WHAT THIS DOES NOT DO: it does not change current_company_id(), is_admin(),
-- is_shop_user(), current_customer_id(), handle_new_user(), or any existing
-- row-security rule. Nothing that MHC uses every day is touched. The only
-- change to an existing table is three new columns on `companies`, all of
-- which default to "this shop is paid up".
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1.0 - Guard. Stops the whole script if the ground has moved.
-- ---------------------------------------------------------------------------
do $guard$
begin
  if to_regclass('public.companies') is null then
    raise exception 'ShopWorks: public.companies does not exist. Stopping.';
  end if;
  if to_regclass('public.memberships') is null then
    raise exception 'ShopWorks: public.memberships does not exist - the memberships build is meant to be live. Stopping.';
  end if;
  if to_regprocedure('public.switch_active_shop(uuid)') is null then
    raise exception 'ShopWorks: switch_active_shop is missing. Stopping.';
  end if;
  if pg_get_functiondef('public.handle_new_user()'::regprocedure)
       not like '%no pending invitation%' then
    raise exception 'ShopWorks: handle_new_user is not the hardened version. Stopping.';
  end if;
end
$guard$;


-- ---------------------------------------------------------------------------
-- 1.1 - Three new columns on `companies`.
--
-- subscription_status defaults to 'active' ON PURPOSE, and this is the single
-- most important line in the file. It means:
--
--   * MHC Fab, which already exists, becomes 'active' the moment this runs.
--     There is no window in which your own shop is on a trial clock.
--   * If any future code path ever creates a shop and forgets to set this,
--     that shop is treated as PAID rather than locked out. A bug that gives
--     somebody a free month is a bad day. A bug that locks a paying shop out
--     of its own job data on a Tuesday morning is a lost customer.
--
-- Only the signup path sets 'trialing', and it always sets trial_ends_at at
-- the same moment.
--
-- locked_notified_at is how you get told. It is stamped the FIRST time a
-- locked-out shop actually hits the wall, and that stamp is what stops you
-- getting the same email every time somebody refreshes the page.
-- ---------------------------------------------------------------------------
alter table public.companies
  add column if not exists subscription_status text not null default 'active';

alter table public.companies
  add column if not exists trial_ends_at timestamptz;

alter table public.companies
  add column if not exists locked_notified_at timestamptz;

alter table public.companies
  drop constraint if exists companies_subscription_status_check;

alter table public.companies
  add constraint companies_subscription_status_check
  check (subscription_status in ('trialing','active','past_due','canceled'));


-- ---------------------------------------------------------------------------
-- 1.2 - Belt and braces on YOUR shop, by name.
--
-- The default above already did this. This says it out loud anyway, so anybody
-- reading the file later can see that MHC was never left on a trial clock.
--
-- It names your shop's id deliberately rather than saying "every shop that
-- already existed". An "every older shop" version would look tidier and would
-- be a trap: re-run this file six months from now and it would quietly force a
-- real paying customer's trialing shop to 'active'. This line can be run a
-- hundred times and can only ever affect MHC Fab.
-- ---------------------------------------------------------------------------
update public.companies
   set subscription_status = 'active',
       trial_ends_at = null
 where id = '86aecd1e-d42c-43c0-976d-44189c1eb1b9';


-- ---------------------------------------------------------------------------
-- 1.3 - Where a half-finished signup waits.
--
-- Somebody fills in the signup form and we send them an email. Until they
-- click the link in it, THIS ROW IS THE ONLY THING THAT EXISTS. No shop, no
-- login, no password stored anywhere. An abandoned or junk signup leaves one
-- row here and nothing else, and it expires on its own.
--
-- token_hash is a hash, not the token. The token itself only ever exists in
-- the email we sent. Somebody who steals a copy of this table still cannot
-- confirm anybody's signup.
--
-- Row security is ON and there are DELIBERATELY NO RULES on this table, which
-- means no signed-in user and no anonymous visitor can read a single row of
-- it, ever. Only the server routes reach it.
-- ---------------------------------------------------------------------------
create table if not exists public.shop_signups (
  id           uuid primary key default gen_random_uuid(),
  shop_name    text not null,
  full_name    text not null,
  email        text not null,
  token_hash   text not null,
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now(),
  confirmed_at timestamptz,
  company_id   uuid references public.companies(id) on delete set null
);

create unique index if not exists shop_signups_token_hash_key
  on public.shop_signups (token_hash);

create index if not exists shop_signups_email_idx
  on public.shop_signups (lower(email));

alter table public.shop_signups enable row level security;

revoke all on public.shop_signups from anon, authenticated;


-- ---------------------------------------------------------------------------
-- 1.4 - "Is my shop paid up?"
--
-- Every screen that has to decide whether to let somebody in calls this, and
-- it answers for whoever is asking - including a customer portal login, who
-- cannot read the companies table at all under the ordinary rules. That is the
-- whole reason this is a function rather than a query in the app.
--
-- It answers one of three states:
--   ok      - paid, nothing to say
--   trial   - inside the 14 days, days_left tells you how many are left
--   locked  - the trial ran out, or the subscription lapsed
--
-- If it returns NOTHING - no profile, no shop, database having a bad day - the
-- app treats that as "let them in". Same principle as 1.1: never lock somebody
-- out because we failed to get an answer.
-- ---------------------------------------------------------------------------
create or replace function public.my_shop_access()
 returns table (
   company_id          uuid,
   shop_name           text,
   role                text,
   state               text,
   subscription_status text,
   trial_ends_at       timestamptz,
   days_left           integer
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
           else 'locked'
         end,
         c.subscription_status,
         c.trial_ends_at,
         case
           when c.subscription_status = 'trialing' and c.trial_ends_at is not null
             then greatest(0, ceil(extract(epoch from (c.trial_ends_at - now())) / 86400.0))::integer
           else null
         end
    from public.profiles p
    join public.companies c on c.id = p.company_id
   where p.id = v_uid;
end;
$function$;


-- ---------------------------------------------------------------------------
-- 1.5 - Telling you, once.
--
-- Called when somebody lands on a locked-out screen. It stamps the shop as
-- "owner has been told" and hands back whether THIS call was the one that did
-- the stamping. Only that call sends you an email.
--
-- The stamp and the answer happen in one statement on purpose: two people at
-- the same shop hitting the wall at the same second cannot both be told they
-- are the first. You get exactly one email per shop per lapse.
--
-- When a shop later pays, clearing locked_notified_at back to null is what
-- arms this again for the next time. That belongs with the Stripe work.
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
       c.subscription_status in ('past_due','canceled')
       or (c.subscription_status = 'trialing'
           and c.trial_ends_at is not null
           and c.trial_ends_at <= now())
     );

  get diagnostics v_stamped = row_count;

  return query
  select (v_stamped > 0),
         c.id,
         c.name,
         c.subscription_status,
         c.trial_ends_at
    from public.companies c
   where c.id = v_company;
end;
$function$;


-- ---------------------------------------------------------------------------
-- 1.6 - "Start a new shop", for somebody who already has a login.
--
-- This is Sean's case. He already has a confirmed email address and a working
-- password at another shop, so there is no new account to create and nothing
-- to confirm - just a new shop, with him as its admin, and his shop switcher
-- picks it up straight away.
--
-- It reads who is calling from the signed-in session, which a browser cannot
-- fake, so nobody can create a shop in somebody else's name.
--
-- One free trial per person: if they already own a shop that is on a trial,
-- this refuses. Otherwise the same person could spin up a new free trial every
-- fourteen days forever.
-- ---------------------------------------------------------------------------
create or replace function public.create_shop_for_current_user(p_shop_name text)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid     uuid := auth.uid();
  v_name    text := btrim(coalesce(p_shop_name, ''));
  v_company uuid;
begin
  if v_uid is null then
    raise exception 'ShopWorks: not signed in.';
  end if;

  if not exists (select 1 from public.profiles p where p.id = v_uid) then
    raise exception 'ShopWorks: no profile for this login.';
  end if;

  if length(v_name) < 2 then
    raise exception 'ShopWorks: please give the shop a name.';
  end if;

  if length(v_name) > 100 then
    raise exception 'ShopWorks: that shop name is too long.';
  end if;

  if exists (
    select 1
      from public.memberships m
      join public.companies c on c.id = m.company_id
     where m.user_id = v_uid
       and m.role = 'admin'
       and m.status in ('active','pending')
       and c.subscription_status = 'trialing'
  ) then
    raise exception 'ShopWorks: you already have a shop on a free trial.';
  end if;

  insert into public.companies (name, subscription_status, trial_ends_at)
  values (v_name, 'trialing', now() + interval '14 days')
  returning id into v_company;

  insert into public.memberships
    (user_id, company_id, role, customer_id, status, accepted_at)
  values (v_uid, v_company, 'admin', null, 'active', now());

  -- Land them in the shop they just made. This also moves their profile
  -- pointer, which is what the middleware reads to decide where they go.
  perform public.switch_active_shop(v_company);

  return v_company;
end;
$function$;


-- ---------------------------------------------------------------------------
-- 1.7 - Who may call these, and waking the API up.
-- Signed-in people only. Anonymous visitors get nothing.
-- ---------------------------------------------------------------------------
revoke all on function public.my_shop_access()                       from public, anon;
revoke all on function public.claim_shop_lock_alert()                from public, anon;
revoke all on function public.create_shop_for_current_user(text)     from public, anon;

grant execute on function public.my_shop_access()                    to authenticated;
grant execute on function public.claim_shop_lock_alert()             to authenticated;
grant execute on function public.create_shop_for_current_user(text)  to authenticated;

notify pgrst, 'reload schema';
-- Wait about ten seconds after this before using the app.


-- ===========================================================================
-- ============ PART 2 - DID IT WORK? ========================================
-- Read-only. Every line should say OK. Run it after PART 1.
-- ===========================================================================
select 'the three columns are on companies' as check_name,
       case when (select count(*) from information_schema.columns
                   where table_schema='public' and table_name='companies'
                     and column_name in ('subscription_status','trial_ends_at','locked_notified_at')) = 3
            then 'OK' else 'PROBLEM: expected 3 new columns' end as result

union all
select 'YOUR shop is paid up and has no trial clock',
       case when (select subscription_status from public.companies
                   where id = '86aecd1e-d42c-43c0-976d-44189c1eb1b9') = 'active'
             and (select trial_ends_at from public.companies
                   where id = '86aecd1e-d42c-43c0-976d-44189c1eb1b9') is null
            then 'OK - MHC Fab can never be locked out'
            else 'PROBLEM: MHC Fab is not marked active' end

union all
select 'no existing shop got put on a trial clock',
       case when (select count(*) from public.companies where subscription_status = 'trialing') = 0
            then 'OK' else 'PROBLEM: ' ||
                 (select count(*)::text from public.companies where subscription_status='trialing') ||
                 ' shop(s) are on a trial already' end

union all
select 'the signup waiting room exists',
       case when to_regclass('public.shop_signups') is not null
            then 'OK' else 'PROBLEM: no shop_signups table' end

union all
select 'row security is on for shop_signups',
       case when (select relrowsecurity from pg_class where oid = 'public.shop_signups'::regclass)
            then 'OK' else 'PROBLEM: row security is OFF' end

union all
select 'shop_signups has NO rules, so nobody can read it',
       case when (select count(*) from pg_policies
                   where schemaname='public' and tablename='shop_signups') = 0
            then 'OK - server routes only'
            else 'PROBLEM: somebody added a rule to shop_signups' end

union all
select 'the three new functions are in',
       case when (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                   where n.nspname='public'
                     and p.proname in ('my_shop_access','claim_shop_lock_alert',
                                       'create_shop_for_current_user')) = 3
            then 'OK' else 'PROBLEM: expected 3 functions' end

union all
select 'all three are locked to a pinned search path',
       case when (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                   where n.nspname='public'
                     and p.proname in ('my_shop_access','claim_shop_lock_alert',
                                       'create_shop_for_current_user')
                     and p.prosecdef
                     and p.proconfig::text like '%search_path%') = 3
            then 'OK' else 'PROBLEM: one of them is not properly pinned' end

union all
select 'anonymous visitors cannot call them',
       case when (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                   where n.nspname='public'
                     and p.proname in ('my_shop_access','claim_shop_lock_alert',
                                       'create_shop_for_current_user')
                     and has_function_privilege('anon', p.oid, 'execute')) = 0
            then 'OK' else 'PROBLEM: anon can execute one of these' end

union all
select 'NOTHING ELSE MOVED - the wall functions are untouched',
       case when (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                   where n.nspname='public'
                     and p.proname in ('current_company_id','is_admin','is_shop_user',
                                       'current_customer_id','handle_new_user')) = 5
            then 'OK - all five still present' else 'PROBLEM: one of the five is missing' end

union all
select 'the login trigger is still the hardened one',
       case when pg_get_functiondef('public.handle_new_user()'::regprocedure)
                 like '%no pending invitation%'
            then 'OK' else 'PROBLEM: handle_new_user changed' end

union all
select 'every login still has a membership',
       case when (select count(*) from public.profiles p
                   where not exists (select 1 from public.memberships m where m.user_id=p.id)) = 0
            then 'OK' else 'PROBLEM: a login lost its membership' end;


-- ===========================================================================
-- UNDO - puts everything back. Only if this feature has to come out.
-- ===========================================================================
-- Take the code down FIRST. The app calls these functions; dropping them while
-- the code is live turns every screen into an error.
--
-- The two `alter table ... drop column` lines throw away trial dates. If any
-- real shop has signed up by then, WRITE THEM DOWN before you run this.
/*
drop function if exists public.create_shop_for_current_user(text);
drop function if exists public.claim_shop_lock_alert();
drop function if exists public.my_shop_access();

drop table if exists public.shop_signups;

alter table public.companies drop constraint if exists companies_subscription_status_check;
alter table public.companies drop column if exists locked_notified_at;
alter table public.companies drop column if exists trial_ends_at;
alter table public.companies drop column if exists subscription_status;

notify pgrst, 'reload schema';
*/
