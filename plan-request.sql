-- ===========================================================================
-- ShopWorks - "choose your plan" on the locked-out screen
-- ===========================================================================
-- Small follow-on to signup-trial-schema.sql. It gives a shop whose trial has
-- ended a way to say WHICH plan they want, instead of being told to write an
-- email.
--
-- There is still no checkout - Stripe is the next piece of work - so what this
-- does is honest about that: it records their choice and tells you. You take
-- the payment however you take it today, then set their shop to 'active'.
-- When Stripe lands, the same buttons become the real checkout and none of
-- this is wasted.
--
-- ORDER: RUN THIS SQL FIRST, THEN DEPLOY THE CODE. Same as last time - nothing
-- live reads these columns until the new code is up.
--
-- REHEARSED: run against a throwaway Postgres with your real policies before
-- you saw it, including the negative cases (can an employee do this? can an
-- admin of one shop set a plan on another? does a junk plan name get in?).
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- PART 1 - THE CHANGE. Run 1.0 to 1.3 as one block.
-- ---------------------------------------------------------------------------

-- 1.0 - Guard.
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
end
$guard$;


-- ---------------------------------------------------------------------------
-- 1.1 - Two columns. Which plan they asked for, and when.
--
-- Deliberately SEPARATE from subscription_status. Asking for a plan is not the
-- same as having one, and nothing in here can move a shop from locked to
-- active. Only you can do that.
-- ---------------------------------------------------------------------------
alter table public.companies
  add column if not exists requested_plan text;

alter table public.companies
  add column if not exists plan_requested_at timestamptz;

alter table public.companies
  drop constraint if exists companies_requested_plan_check;

alter table public.companies
  add constraint companies_requested_plan_check
  check (requested_plan is null
         or requested_plan in ('band_1_15','band_16_50','band_51_150'));


-- ---------------------------------------------------------------------------
-- 1.2 - "This is the plan we want."
--
-- Written as a function rather than letting the app update the companies row
-- directly, for two reasons:
--   * it can only ever write those two columns, so there is no route through
--     it to anything else on that row;
--   * it works out who is calling from the signed-in session, so a shop can
--     only speak for itself.
--
-- Admins only. An employee choosing a plan for the shop is not a thing.
-- ---------------------------------------------------------------------------
create or replace function public.request_plan(p_plan text)
 returns table (shop_id uuid, shop_name text, plan text)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid     uuid := auth.uid();
  v_company uuid;
  v_role    text;
  v_plan    text := btrim(coalesce(p_plan, ''));
begin
  if v_uid is null then
    raise exception 'ShopWorks: not signed in.';
  end if;

  if v_plan not in ('band_1_15','band_16_50','band_51_150') then
    raise exception 'ShopWorks: that is not a plan we offer.';
  end if;

  select p.company_id, p.role into v_company, v_role
    from public.profiles p
   where p.id = v_uid;

  if v_company is null then
    raise exception 'ShopWorks: no shop for this login.';
  end if;

  if v_role is distinct from 'admin' then
    raise exception 'ShopWorks: only the shop owner can choose a plan.';
  end if;

  update public.companies c
     set requested_plan = v_plan,
         plan_requested_at = now()
   where c.id = v_company;

  return query
  select c.id, c.name, c.requested_plan
    from public.companies c
   where c.id = v_company;
end;
$function$;


-- ---------------------------------------------------------------------------
-- 1.3 - Who may call it, and wake the API up.
-- ---------------------------------------------------------------------------
revoke all on function public.request_plan(text) from public, anon;
grant execute on function public.request_plan(text) to authenticated;

notify pgrst, 'reload schema';
-- Wait about ten seconds after this before using the app.


-- ---------------------------------------------------------------------------
-- PART 2 - DID IT WORK? Read-only. Every line should say OK.
-- ---------------------------------------------------------------------------
select 'the two columns are on companies' as check_name,
       case when (select count(*) from information_schema.columns
                   where table_schema='public' and table_name='companies'
                     and column_name in ('requested_plan','plan_requested_at')) = 2
            then 'OK' else 'PROBLEM: expected 2 new columns' end as result

union all
select 'a junk plan name cannot be stored',
       case when (select count(*) from pg_constraint
                   where conname = 'companies_requested_plan_check') = 1
            then 'OK' else 'PROBLEM: the check constraint is missing' end

union all
select 'the function is in, and pinned',
       case when (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                   where n.nspname='public' and p.proname='request_plan'
                     and p.prosecdef and p.proconfig::text like '%search_path%') = 1
            then 'OK' else 'PROBLEM' end

union all
select 'anonymous visitors cannot call it',
       case when (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                   where n.nspname='public' and p.proname='request_plan'
                     and has_function_privilege('anon', p.oid, 'execute')) = 0
            then 'OK' else 'PROBLEM: anon can execute it' end

union all
select 'nobody was accidentally put on a plan',
       case when (select count(*) from public.companies where requested_plan is not null) = 0
            then 'OK' else 'PROBLEM: a shop already has a requested_plan' end

union all
select 'MHC Fab is still active and untouched',
       case when (select subscription_status from public.companies
                   where id = '86aecd1e-d42c-43c0-976d-44189c1eb1b9') = 'active'
            then 'OK' else 'PROBLEM' end;


-- ---------------------------------------------------------------------------
-- WHEN A SHOP PAYS - this is the line that switches them back on.
-- ---------------------------------------------------------------------------
/*
update public.companies
   set subscription_status = 'active',
       trial_ends_at       = null,
       locked_notified_at  = null,   -- re-arms the alert for a future lapse
       requested_plan      = null,
       plan_requested_at   = null
 where name = 'THE SHOP NAME';
*/


-- ---------------------------------------------------------------------------
-- UNDO
-- ---------------------------------------------------------------------------
/*
drop function if exists public.request_plan(text);
alter table public.companies drop constraint if exists companies_requested_plan_check;
alter table public.companies drop column if exists plan_requested_at;
alter table public.companies drop column if exists requested_plan;
notify pgrst, 'reload schema';
*/


-- ===========================================================================
-- PART 3 - CLOSE A HOLE THE LOCKOUT FEATURE JUST MADE IMPORTANT
-- ===========================================================================
-- ⚠️ READ THIS BEFORE RUNNING IT. It is a real fix, and it is the one part of
-- today's work that can break an existing screen if I have got the column list
-- wrong.
--
-- THE PROBLEM
-- The rule `companies_admin_update` lets a shop's admin update THEIR OWN shop
-- row - which is right - but it does not say WHICH COLUMNS. Until today that
-- did not matter, because every column on that row was a setting they were
-- entitled to change anyway.
--
-- Today three of those columns became the subscription. So as things stand, a
-- shop whose trial has ended can switch itself back on with a single call to
-- the API - no password cracking, no clever trick, just the ordinary
-- permissions their own login already has. Proven in rehearsal: the locked
-- admin ran one UPDATE and went straight back to full access.
--
-- That is a bigger thing than the hole you already knowingly accepted. You
-- accepted that a locked shop's DATA is still readable outside the app. This
-- is the lockout not actually locking.
--
-- THE FIX
-- Say which columns a signed-in person may write, instead of all of them. The
-- rule about which ROWS they can reach does not change at all. Your Settings
-- page keeps working; the subscription columns become writable only by you in
-- the dashboard, and by the two functions that are meant to touch them.
--
-- ⚠️ THE ONE RISK: if a future screen ever writes a NEW column on `companies`,
-- that column must be added to the grant below or the save will fail. The list
-- was taken from the only two places in the whole app that update this table,
-- both in app/admin/settings/page.tsx, plus every other settings-ish column
-- that exists today for good measure.
-- ---------------------------------------------------------------------------

revoke update on public.companies from authenticated;

grant update (
  name,
  slug,
  is_active,
  updated_at,
  burden_rate_per_hour,
  shop_labor_rate_per_hour,
  material_markup_percent,
  inv_show_purchased_parts,
  inv_show_fabricated,
  inv_track_grade,
  inv_track_wall_thickness,
  inv_track_drops,
  inv_use_nesting,
  nest_kerf_inches,
  nest_min_drop_inches
) on public.companies to authenticated;

notify pgrst, 'reload schema';


-- ---------------------------------------------------------------------------
-- PART 3 CHECK - read-only. Both lines should say OK.
-- ---------------------------------------------------------------------------
select 'settings columns are still writable' as check_name,
       case when has_column_privilege('authenticated','public.companies','burden_rate_per_hour','update')
             and has_column_privilege('authenticated','public.companies','name','update')
             and has_column_privilege('authenticated','public.companies','inv_use_nesting','update')
            then 'OK - your Settings page still saves'
            else 'PROBLEM: a settings column lost its permission' end as result

union all
select 'the subscription columns are NOT writable',
       case when not has_column_privilege('authenticated','public.companies','subscription_status','update')
             and not has_column_privilege('authenticated','public.companies','trial_ends_at','update')
             and not has_column_privilege('authenticated','public.companies','requested_plan','update')
            then 'OK - a locked shop can no longer switch itself back on'
            else 'PROBLEM: the subscription is still writable from the app' end;
