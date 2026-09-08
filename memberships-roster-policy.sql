-- ============================================================
-- SHOPWORKS — KEEP YOUR ROSTER READABLE
-- A four-line follow-on to memberships-schema.sql.
--
-- WHY THIS IS NEEDED
--   Your Employees page reads people's names and emails out of `profiles`.
--   The rule that lets you do that, profiles_self_read, says "your own row,
--   or any row in YOUR shop" — and "your shop" means the shop that row is
--   currently pointed at.
--
--   That was always true and never mattered, because everybody pointed at
--   MHC. Now that a person can belong to two shops, the day Sean switches
--   his active shop over to Eurowise, his profile row points at Eurowise —
--   and he would silently disappear off your Employees and Customers pages.
--   You would still have him as a member; you just couldn't read his name.
--
-- WHAT THIS DOES
--   Adds ONE extra read rule: an admin may read the profile of anyone who
--   holds a membership in that admin's shop, whichever shop that person
--   happens to be looking at right now.
--
--   It only ADDS reading. Rules of this kind are OR'd together, so nothing
--   that is readable today stops being readable, and nothing becomes
--   writable. It grants no access to anyone who is not an admin.
--
-- ORDER
--   Run this BEFORE the code that ships the shop switcher. It is harmless to
--   run now — today nobody has a second membership, so it changes nothing
--   you can observe.
--
-- REHEARSED: run against a throwaway copy of your schema, including the case
-- it exists for — a member whose active shop had moved away, who was
-- invisible before this rule and readable after it.
-- ============================================================


-- ============================================================
-- ============ PART 0 — WHAT IS THERE NOW (READ ONLY) ========
-- I expect exactly two rules: profiles_admin_write and profiles_self_read.
-- Paste this back before running PART 1.
-- ============================================================
select policyname, cmd, roles::text as applies_to,
       coalesce(qual, '') as using_clause,
       coalesce(with_check, '') as with_check_clause
from pg_policies
where schemaname = 'public' and tablename = 'profiles'
order by policyname;


-- ============================================================
-- ============ PART 1 — THE CHANGE ===========================
-- ============================================================
drop policy if exists profiles_admin_read_members on public.profiles;

create policy profiles_admin_read_members on public.profiles
  for select
  using (
    is_admin()
    and exists (
      select 1
        from public.memberships m
       where m.user_id = profiles.id
         and m.company_id = current_company_id()
    )
  );


-- ------------------------------------------------------------
-- Make the app's access to the new table explicit.
--
-- Supabase normally hands new tables in `public` to the signed-in roles
-- automatically, and it almost certainly already did. But if it ever did not,
-- every screen would fail with "permission denied for table memberships" —
-- and that is the table your whole login now leans on. This says it out loud
-- rather than trusting a default. Running it when it is already true does
-- nothing at all.
--
-- This is table-level permission only. WHICH ROWS anyone can see is still
-- decided entirely by the two rules from memberships-schema.sql.
-- ------------------------------------------------------------
grant select, insert, update, delete on public.memberships to authenticated;
grant select, insert, update, delete on public.memberships to service_role;


-- ============================================================
-- ============ PART 2 — DID IT WORK? =========================
-- All three lines should say OK.
-- ============================================================
select 'the new rule is in' as check_name,
       case when exists (
              select 1 from pg_policies
               where schemaname='public' and tablename='profiles'
                 and policyname='profiles_admin_read_members')
            then 'OK' else 'PROBLEM: rule missing' end as result

union all
select 'the two original rules are untouched',
       case when (select count(*) from pg_policies
                   where schemaname='public' and tablename='profiles'
                     and policyname in ('profiles_admin_write','profiles_self_read')) = 2
            then 'OK' else 'PROBLEM: an original rule is missing' end

union all
select 'the app can reach the memberships table',
       case when has_table_privilege('authenticated','public.memberships','SELECT')
             and has_table_privilege('authenticated','public.memberships','UPDATE')
            then 'OK' else 'PROBLEM: signed-in users cannot read the table' end;


-- ============================================================
-- ============ UNDO ==========================================
-- ============================================================
-- drop policy if exists profiles_admin_read_members on public.profiles;
--
-- Leave the grants alone. Removing them would break the app, and they are
-- what Supabase would have set up by itself anyway.
