-- ============================================================
-- SHOPWORKS — MEMBERSHIPS
-- One login can belong to more than one shop.
--
-- WHY THIS EXISTS
--   Today a login belongs to exactly ONE shop, in exactly ONE role, because
--   the profiles row carries a single company_id / role / customer_id. So
--   Sean cannot be Eurowise's admin AND MHC's portal purchaser on one email
--   address. Once several shops are on ShopWorks and they buy from each
--   other, that comes up every time.
--
-- WHAT THIS DOES
--   Adds a memberships table that says which shops a person may reach and in
--   what role. The profiles row stays exactly as it is and becomes a POINTER
--   to whichever membership is active right now.
--
--   That is the whole reason this is safe. current_company_id(), is_admin(),
--   is_shop_user() and current_customer_id() are NOT touched, so none of the
--   ~90 row-security rules in the database change, and none of the 40 screens
--   that ask profiles "what's my company_id" change either. Everything keeps
--   working the way it works today; a second shop simply becomes possible.
--
-- HOW TO RUN IT
--   1. PART 0 first. It is read-only. Paste the results back to me.
--   2. Only then PART 1. It stops itself with a clear message if anything is
--      not the way PART 0 said it was.
--   3. Then PART 2, which should come back all OK.
--   4. Then NOTIFY pgrst, 'reload schema'; and wait ten seconds.
--   Run ONE numbered block at a time — the editor only shows the last result.
--
--   This runs as postgres, so row security does not apply to it.
--
-- WHAT IS NOT IN HERE
--   Nothing about one shop seeing another shop's data. Memberships let a
--   PERSON reach two shops. They do not connect the two shops' records.
--
-- ONE THING TO WATCH BETWEEN THIS SCRIPT AND THE CODE
--   The Employees page still writes role and is_active straight onto
--   profiles. Until the new code is deployed, those two buttons — Make
--   admin and Deactivate — would put the pointer and the membership out of
--   step, and the next membership change would quietly undo them. So after
--   you run this, don't promote or deactivate anybody until we have pushed
--   the code. Everything else in the app is unaffected.
--
-- REHEARSED, NOT JUST WRITTEN
--   PART 1 and PART 2 were run end to end against a throwaway copy of this
--   schema before you saw them, along with Sean's actual case: invited to
--   Eurowise as admin while staying MHC's portal customer, accepting,
--   switching, being switched off by one shop and keeping the other, being
--   switched off by both and losing everything, and being turned back on.
--   The security cases were run too — another employee could not accept
--   Sean's invitation, could not see anyone else's memberships, and could
--   not hand himself an admin membership; and an MHC admin could not write
--   a membership into another shop. One real bug turned up that way and is
--   fixed. It is still your database, so PART 0 first.
-- ============================================================


-- ============================================================
-- ============ PART 0 — PRE-FLIGHT (READ ONLY) ===============
-- Nothing below in PART 0 changes anything.
-- ============================================================

-- ------------------------------------------------------------
-- QUERY 0a — the four functions everything depends on.
-- I expect: current_company_id, current_customer_id, is_admin, is_shop_user,
-- handle_new_user. Paste this back so I can see the live text, not my memory
-- of it. If any of these has changed, stop and tell me.
-- ------------------------------------------------------------
select p.proname as function_name,
       pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('current_company_id','current_customer_id','is_admin',
                    'is_shop_user','handle_new_user')
order by p.proname;


-- ------------------------------------------------------------
-- QUERY 0b — what columns profiles actually has today.
-- ------------------------------------------------------------
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'profiles'
order by ordinal_position;


-- ------------------------------------------------------------
-- QUERY 0c — does the data match what the new table will assume?
-- Every row should say OK. Anything else, stop and tell me.
-- ------------------------------------------------------------
select 'roles in use' as check_name,
       case when count(*) = 0 then 'OK'
            else 'PROBLEM: unexpected role(s): ' || string_agg(distinct role, ', ') end as result
from public.profiles
where role is null or role not in ('admin','employee','customer')

union all
select 'customer logins have a customer attached',
       case when count(*) = 0 then 'OK'
            else 'PROBLEM: ' || count(*) || ' customer profile(s) with no customer_id' end
from public.profiles
where role = 'customer' and customer_id is null

union all
select 'staff logins have no customer attached',
       case when count(*) = 0 then 'OK'
            else 'PROBLEM: ' || count(*) || ' staff profile(s) carrying a customer_id' end
from public.profiles
where role in ('admin','employee') and customer_id is not null

union all
select 'every profile belongs to a shop',
       case when count(*) = 0 then 'OK'
            else 'PROBLEM: ' || count(*) || ' profile(s) with no company_id' end
from public.profiles
where company_id is null

union all
select 'companies on this database',
       count(*)::text || ' (expect 1 — just MHC)'
from public.companies

union all
select 'profiles by role',
       string_agg(role || ': ' || n::text, ', ' order by role)
from (select role, count(*) as n from public.profiles group by role) s;


-- ------------------------------------------------------------
-- QUERY 0d — is anything already using the names this script creates?
-- "No rows returned" is the answer I want.
-- ------------------------------------------------------------
select 'table' as kind, table_name as name
from information_schema.tables
where table_schema = 'public' and table_name = 'memberships'
union all
select 'function', p.proname
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('sync_active_membership','switch_active_shop',
                    'accept_membership','decline_membership','my_memberships');


-- ============================================================
-- ============ PART 1 — THE CHANGE ===========================
-- Run this only after PART 0 comes back the way it should.
-- Run it as ONE block — the guard at the top and the work below
-- belong together.
-- ============================================================

-- ------------------------------------------------------------
-- 1.0 — Guard. Stops the whole script if the ground has moved.
-- ------------------------------------------------------------
do $guard$
begin
  if to_regclass('public.companies') is null then
    raise exception 'ShopWorks: public.companies does not exist. Stopping.';
  end if;
  if to_regclass('public.customers') is null then
    raise exception 'ShopWorks: public.customers does not exist. Stopping.';
  end if;
  if exists (select 1 from public.profiles
              where role is null or role not in ('admin','employee','customer')) then
    raise exception 'ShopWorks: profiles contains a role I do not recognise. Stopping.';
  end if;
  if exists (select 1 from public.profiles
              where role = 'customer' and customer_id is null) then
    raise exception 'ShopWorks: a customer profile has no customer_id. Stopping.';
  end if;
  if exists (select 1 from public.profiles where company_id is null) then
    raise exception 'ShopWorks: a profile has no company_id. Stopping.';
  end if;
end
$guard$;


-- ------------------------------------------------------------
-- 1.1 — The table.
--
-- One row per person per shop. status is the only flag:
--   pending  — another shop has asked to add this person; they have not
--              said yes yet, and it grants nothing.
--   active   — real access.
--   inactive — that shop switched them off. Their other shops are unaffected.
--   declined — they said no.
--
-- One row per (user, shop) on purpose: a person is either staff or a portal
-- customer at a given shop, never both. Cross-shop is the case this is for.
-- ------------------------------------------------------------
create table if not exists public.memberships (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  company_id   uuid not null references public.companies(id) on delete cascade,
  role         text not null check (role in ('admin','employee','customer')),
  customer_id  uuid references public.customers(id) on delete cascade,
  status       text not null default 'active'
               check (status in ('pending','active','inactive','declined')),
  invited_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  accepted_at  timestamptz,
  unique (user_id, company_id),
  constraint memberships_customer_matches_role check (
    (role = 'customer'  and customer_id is not null) or
    (role <> 'customer' and customer_id is null)
  )
);

create index if not exists memberships_company_idx on public.memberships (company_id);
create index if not exists memberships_user_status_idx on public.memberships (user_id, status);


-- ------------------------------------------------------------
-- 1.2 — Row security on the new table.
--
-- A person can always read their OWN memberships — that is what feeds the
-- shop switcher and the "someone wants to add you" screen.
-- An admin manages memberships in their OWN shop and nowhere else.
-- Employees need nothing beyond their own rows, and customer logins the same,
-- so there is deliberately no employee policy here beyond self_read.
-- ------------------------------------------------------------
alter table public.memberships enable row level security;

drop policy if exists memberships_self_read on public.memberships;
create policy memberships_self_read on public.memberships
  for select
  using (user_id = auth.uid());

drop policy if exists memberships_admin_all on public.memberships;
create policy memberships_admin_all on public.memberships
  for all
  using (company_id = current_company_id() and is_admin())
  with check (company_id = current_company_id() and is_admin());


-- ------------------------------------------------------------
-- 1.3 — Backfill. Every login that exists today becomes exactly one
-- membership, saying the same thing its profile already says.
-- ------------------------------------------------------------
insert into public.memberships
  (user_id, company_id, role, customer_id, status, created_at, accepted_at)
select p.id,
       p.company_id,
       p.role,
       p.customer_id,
       case when p.is_active then 'active' else 'inactive' end,
       coalesce(p.created_at, now()),
       coalesce(p.created_at, now())
from public.profiles p
where p.company_id is not null
on conflict (user_id, company_id) do nothing;


-- ------------------------------------------------------------
-- 1.4 — The rule that keeps the pointer honest.
--
-- profiles is now a pointer at one membership. This trigger makes sure the
-- pointer can never say something the memberships table disagrees with, no
-- matter what changes a membership — this script, a future screen, or a hand
-- edit in the dashboard.
--
--   * pointer still valid  -> copy role / customer_id across, mark active
--   * pointer went stale   -> move it to another active membership
--   * nothing active left  -> the person cannot sign in anywhere
-- ------------------------------------------------------------
create or replace function public.sync_active_membership()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  target_user uuid;
  pointed_at  uuid;
  fallback    record;
begin
  -- On a delete there is no NEW record to read, so ask OLD instead.
  if TG_OP = 'DELETE' then
    target_user := OLD.user_id;
  else
    target_user := NEW.user_id;
  end if;

  select company_id into pointed_at
    from public.profiles
   where id = target_user;

  -- No profile row (the person was deleted outright): nothing to keep honest.
  if not found then
    return null;
  end if;

  -- Is the shop the profile currently points at still open to them?
  if exists (
    select 1 from public.memberships m
     where m.user_id = target_user
       and m.company_id = pointed_at
       and m.status = 'active'
  ) then
    update public.profiles p
       set role        = m.role,
           customer_id = m.customer_id,
           is_active   = true
      from public.memberships m
     where p.id = target_user
       and m.user_id = target_user
       and m.company_id = pointed_at
       and m.status = 'active'
       and (p.role        is distinct from m.role
         or p.customer_id is distinct from m.customer_id
         or p.is_active   is distinct from true);
    return null;
  end if;

  -- The pointer is stale. Is there another shop they can still reach?
  select m.company_id, m.role, m.customer_id
    into fallback
    from public.memberships m
   where m.user_id = target_user
     and m.status = 'active'
   order by m.created_at
   limit 1;

  if found then
    update public.profiles
       set company_id  = fallback.company_id,
           role        = fallback.role,
           customer_id = fallback.customer_id,
           is_active   = true
     where id = target_user;
  else
    -- Nothing active anywhere. The login stays, but it opens nothing.
    update public.profiles
       set is_active = false
     where id = target_user;
  end if;

  return null;
end;
$function$;

drop trigger if exists memberships_sync_profile on public.memberships;
create trigger memberships_sync_profile
after insert or update or delete on public.memberships
for each row execute function public.sync_active_membership();


-- ------------------------------------------------------------
-- 1.5 — Switching shops.
--
-- The only way the pointer moves by hand. It reads who is calling from the
-- signed-in session (auth.uid()), which a browser cannot fake, and refuses
-- any shop the caller does not actually have active access to.
-- ------------------------------------------------------------
create or replace function public.switch_active_shop(p_company_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  m record;
begin
  if auth.uid() is null then
    raise exception 'ShopWorks: not signed in.';
  end if;

  select company_id, role, customer_id into m
    from public.memberships
   where user_id = auth.uid()
     and company_id = p_company_id
     and status = 'active';

  if not found then
    raise exception 'ShopWorks: you do not have access to that shop.';
  end if;

  update public.profiles
     set company_id  = m.company_id,
         role        = m.role,
         customer_id = m.customer_id,
         is_active   = true
   where id = auth.uid();
end;
$function$;


-- ------------------------------------------------------------
-- 1.6 — Saying yes or no to another shop's request.
-- Same idea: the caller can only answer for themselves, and can only answer
-- something that is actually pending.
-- ------------------------------------------------------------
create or replace function public.accept_membership(p_membership_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  update public.memberships
     set status = 'active',
         accepted_at = now()
   where id = p_membership_id
     and user_id = auth.uid()
     and status = 'pending';

  if not found then
    raise exception 'ShopWorks: no pending request for you with that id.';
  end if;
end;
$function$;

create or replace function public.decline_membership(p_membership_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  update public.memberships
     set status = 'declined'
   where id = p_membership_id
     and user_id = auth.uid()
     and status = 'pending';

  if not found then
    raise exception 'ShopWorks: no pending request for you with that id.';
  end if;
end;
$function$;


-- ------------------------------------------------------------
-- 1.7 — What the switcher shows.
--
-- The existing rules only let a person read their OWN shop's row in
-- companies, so they could not read the NAME of the second shop they belong
-- to. This hands back just the names of shops they are actually a member of
-- and nothing else about them.
-- ------------------------------------------------------------
create or replace function public.my_memberships()
 returns table (
   membership_id uuid,
   company_id    uuid,
   company_name  text,
   role          text,
   status        text,
   is_current    boolean
 )
 language sql
 security definer
 set search_path to 'public'
as $function$
  select m.id,
         m.company_id,
         c.name,
         m.role,
         m.status,
         (m.company_id = (select pr.company_id from public.profiles pr where pr.id = auth.uid()))
  from public.memberships m
  join public.companies c on c.id = m.company_id
  where m.user_id = auth.uid()
    and m.status in ('active','pending')
  order by c.name;
$function$;


-- ------------------------------------------------------------
-- 1.8 — Who may call these.
-- Signed-in people only. Anonymous visitors get nothing.
-- ------------------------------------------------------------
revoke all on function public.switch_active_shop(uuid) from public, anon;
revoke all on function public.accept_membership(uuid)  from public, anon;
revoke all on function public.decline_membership(uuid) from public, anon;
revoke all on function public.my_memberships()         from public, anon;

grant execute on function public.switch_active_shop(uuid) to authenticated;
grant execute on function public.accept_membership(uuid)  to authenticated;
grant execute on function public.decline_membership(uuid) to authenticated;
grant execute on function public.my_memberships()         to authenticated;


-- ------------------------------------------------------------
-- 1.9 — New invited accounts also get a membership.
--
-- This is your LIVE handle_new_user, copied character for character out of
-- the database on 2026-09-08, with ONE addition marked THE ONLY ADDITION.
-- Everything else — including every comment — is exactly what is running
-- now, so you can read the two side by side and see that nothing else moved.
-- The email address is still the only thing it trusts, there is still no
-- branch that can produce 'admin', and it still refuses outright when there
-- is no pending invitation.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  claimed_role      TEXT;
  normalized_email  TEXT;
  granted_company   UUID;
  granted_customer  UUID;
  granted_role      TEXT;
  invite_full_name  TEXT;
BEGIN
  -- The email address is the only thing we trust from the sign-up request,
  -- because Supabase owns it. Everything else has to be earned by an
  -- invitation row that a signed-in admin of a real shop created.
  normalized_email := lower(trim(COALESCE(NEW.email, '')));

  -- We read the requested role only to know WHICH invitation list to search.
  -- It never becomes the stored role by itself.
  claimed_role := lower(trim(COALESCE(NEW.raw_user_meta_data->>'role', 'employee')));

  IF claimed_role = 'customer' THEN
    SELECT ci.company_id, ci.customer_id, ci.full_name
      INTO granted_company, granted_customer, invite_full_name
      FROM public.customer_invitations ci
     WHERE lower(trim(ci.email)) = normalized_email
       AND ci.status = 'pending'
     ORDER BY ci.created_at DESC
     LIMIT 1;

    granted_role := 'customer';
  ELSE
    -- Anything that is not a customer invite is treated as an employee
    -- invite. Note there is no branch that can ever produce 'admin'.
    SELECT ei.company_id, ei.full_name
      INTO granted_company, invite_full_name
      FROM public.employee_invitations ei
     WHERE lower(trim(ei.email)) = normalized_email
       AND ei.status = 'pending'
     ORDER BY ei.created_at DESC
     LIMIT 1;

    granted_customer := NULL;
    granted_role := 'employee';
  END IF;

  -- No pending invitation means nobody with authority asked for this account.
  -- Refuse it outright: no login, no profile, nothing left behind.
  IF granted_company IS NULL THEN
    RAISE EXCEPTION
      'ShopWorks: no pending invitation for %. Account not created.',
      normalized_email
      USING ERRCODE = 'check_violation';
  END IF;

  -- A customer invitation without a customer attached is a broken row; refuse
  -- rather than create a portal login that belongs to nobody.
  IF granted_role = 'customer' AND granted_customer IS NULL THEN
    RAISE EXCEPTION
      'ShopWorks: customer invitation for % has no customer attached. Account not created.',
      normalized_email
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.profiles (id, email, full_name, role, company_id, customer_id)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(
      NULLIF(trim(COALESCE(NEW.raw_user_meta_data->>'full_name', '')), ''),
      NULLIF(trim(COALESCE(invite_full_name, '')), ''),
      ''
    ),
    granted_role,
    granted_company,
    granted_customer
  );

  -- ================= THE ONLY ADDITION =================
  -- The membership that matches the profile we just wrote. The profile has to
  -- be inserted FIRST, because the memberships trigger reads it.
  INSERT INTO public.memberships
    (user_id, company_id, role, customer_id, status, accepted_at)
  VALUES (NEW.id, granted_company, granted_role, granted_customer, 'active', now())
  ON CONFLICT (user_id, company_id) DO NOTHING;
  -- =====================================================

  RETURN NEW;
END;
$function$;


-- ------------------------------------------------------------
-- 1.10 — Wake the API up to the new table.
-- Run this on its own, then wait about ten seconds.
-- ------------------------------------------------------------
notify pgrst, 'reload schema';


-- ============================================================
-- ============ PART 2 — DID IT WORK? =========================
-- Every line should say OK.
-- ============================================================
select 'table exists' as check_name,
       case when to_regclass('public.memberships') is not null
            then 'OK' else 'PROBLEM: no memberships table' end as result

union all
select 'row security is on',
       case when (select relrowsecurity from pg_class where oid = 'public.memberships'::regclass)
            then 'OK' else 'PROBLEM: row security is OFF' end

union all
select 'two rules on memberships',
       case when (select count(*) from pg_policies
                   where schemaname='public' and tablename='memberships') = 2
            then 'OK' else 'PROBLEM: expected 2 rules, found ' ||
                 (select count(*)::text from pg_policies
                   where schemaname='public' and tablename='memberships') end

union all
select 'every login has a membership',
       case when (select count(*) from public.profiles p
                   where not exists (select 1 from public.memberships m
                                      where m.user_id = p.id)) = 0
            then 'OK' else 'PROBLEM: ' ||
                 (select count(*)::text from public.profiles p
                   where not exists (select 1 from public.memberships m
                                      where m.user_id = p.id)) || ' login(s) with none' end

union all
select 'memberships agree with profiles',
       case when (select count(*) from public.profiles p
                   join public.memberships m
                     on m.user_id = p.id and m.company_id = p.company_id
                  where m.role is distinct from p.role
                     or m.customer_id is distinct from p.customer_id) = 0
            then 'OK' else 'PROBLEM: a membership disagrees with its profile' end

union all
select 'the five functions are in',
       case when (select count(*) from pg_proc p
                   join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname='public'
                    and p.proname in ('sync_active_membership','switch_active_shop',
                                      'accept_membership','decline_membership',
                                      'my_memberships')) = 5
            then 'OK' else 'PROBLEM: one or more functions missing' end

union all
select 'the sync trigger is in',
       case when exists (select 1 from pg_trigger
                          where tgname = 'memberships_sync_profile'
                            and not tgisinternal)
            then 'OK' else 'PROBLEM: trigger missing' end

union all
select 'handle_new_user still refuses uninvited accounts',
       case when pg_get_functiondef((select p.oid from pg_proc p
                                      join pg_namespace n on n.oid=p.pronamespace
                                     where n.nspname='public'
                                       and p.proname='handle_new_user'))
                 like '%no pending invitation for%'
            then 'OK' else 'PROBLEM: the guard text is gone' end

union all
select 'handle_new_user cannot mint an admin',
       case when pg_get_functiondef((select p.oid from pg_proc p
                                      join pg_namespace n on n.oid=p.pronamespace
                                     where n.nspname='public'
                                       and p.proname='handle_new_user'))
                 not like '%granted_role := ''admin''%'
            then 'OK' else 'PROBLEM: an admin branch appeared' end

union all
select 'the four wall functions were left alone',
       case when (select count(*) from pg_proc p
                   join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname='public'
                    and p.proname in ('current_company_id','current_customer_id',
                                      'is_admin','is_shop_user')) = 4
            then 'OK' else 'PROBLEM: one of them is missing' end;


-- ============================================================
-- ============ UNDO ==========================================
-- Only if something is wrong. Run top to bottom.
-- Nothing in PART 1 removed or rewrote existing data — profiles was not
-- altered — so undoing puts the database back exactly where it started.
-- ============================================================
-- drop trigger if exists memberships_sync_profile on public.memberships;
-- drop function if exists public.sync_active_membership();
-- drop function if exists public.switch_active_shop(uuid);
-- drop function if exists public.accept_membership(uuid);
-- drop function if exists public.decline_membership(uuid);
-- drop function if exists public.my_memberships();
-- drop table if exists public.memberships;
--
-- Then put handle_new_user back by re-running PART 1 of
-- handle-new-user-hardening.sql, which holds its exact current text.
--
-- Then: notify pgrst, 'reload schema';
