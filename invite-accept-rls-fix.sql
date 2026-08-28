-- =====================================================================
-- invite-accept-rls-fix.sql
-- 2026-08-28
--
-- THE PROBLEM
--   When an invited employee or customer sets their password, the app
--   marks their invitation row "accepted". That update has always
--   silently done nothing for anyone who is not an admin.
--
--   Why: to CHANGE a row, Postgres must first FIND it, and finding it
--   needs read permission. Both invitation tables have an UPDATE rule
--   letting a person accept their own invitation, but no SELECT rule
--   letting them SEE their own invitation - only admins could read the
--   table at all. So the update matched zero rows. The accept-invite
--   page throws that result away without checking it, so nothing ever
--   surfaced.
--
--   Symptom: people stay listed under "Pending invites" forever, even
--   though they set their password and are working normally.
--
--   CONFIRMED 2026-08-28 by replaying the exact update under the
--   employee's own identity in a rolled-back transaction:
--     0 rows updated before adding a read rule
--     1 row  updated after
--
--   This is the same recurring trap as the job-status, scrap and photo
--   bugs: works for admin, silently does nothing for the crew, because
--   no employee-level policy exists for that command.
--
-- WHAT THIS FILE DOES
--   PART 0  read-only - show the current rules so you can see the gap
--   PART 1  the fix   - add "read your own invitation" to both tables
--   PART 2  data      - mark already-stuck rows accepted (MHC only)
--   PART 3  verify    - prove it worked
--   UNDO              - at the bottom, commented out
--
-- HOW TO RUN
--   One part at a time, in order, in the Supabase SQL Editor. Read the
--   output of each part before running the next. These are policy and
--   data changes only - no table structure changes - so there is NO
--   schema-cache reload needed and no deploy required.
-- =====================================================================


-- ---------------------------------------------------------------------
-- PART 0 - READ ONLY. Look before you change anything.
--
-- Expect to see, for each table, only:
--   *_admin_all    ALL     (gated on is_admin())
--   *_self_accept  UPDATE
-- If a SELECT policy other than the admin one is ALREADY listed for a
-- table, that table is already fixed - skip its statement in PART 1.
-- ---------------------------------------------------------------------
select tablename, policyname, cmd, qual
  from pg_policies
 where schemaname = 'public'
   and tablename in ('employee_invitations', 'customer_invitations')
 order by tablename, policyname;


-- ---------------------------------------------------------------------
-- PART 1 - THE FIX
--
-- Lets a signed-in person read ONLY invitation rows that carry their own
-- email address, inside their own shop. Nobody gains sight of anyone
-- else's invitation, and nobody can read another shop's rows: the same
-- two tests the existing accept rule already applies.
-- ---------------------------------------------------------------------
create policy employee_invitations_self_read
  on public.employee_invitations
  for select
  using (
    company_id = current_company_id()
    and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );

create policy customer_invitations_self_read
  on public.customer_invitations
  for select
  using (
    company_id = current_company_id()
    and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );


-- ---------------------------------------------------------------------
-- PART 2 - CLEAN UP THE ROWS THAT ARE ALREADY STUCK
--
-- Scoped to MHC's company_id. Marks an invitation accepted only where a
-- real login exists for that address AND that login has actually signed
-- in at least once - which is the proof they set their password.
--
-- Anyone who has NEVER signed in is deliberately left pending. That is
-- correct: they still have a live invitation to use. (Jordan, invited
-- 2026-08-28 and not yet signed in, stays pending on purpose.)
--
-- This matters beyond tidiness: under the hardened handle_new_user
-- trigger, a leftover pending row is a standing permission slip to
-- create an account at that email address.
-- ---------------------------------------------------------------------
update public.employee_invitations i
   set status = 'accepted',
       accepted_at = coalesce(i.accepted_at, u.last_sign_in_at, now())
  from auth.users u
 where lower(u.email) = lower(i.email)
   and i.company_id = '86aecd1e-d42c-43c0-976d-44189c1eb1b9'
   and i.status = 'pending'
   and u.last_sign_in_at is not null;

update public.customer_invitations i
   set status = 'accepted',
       accepted_at = coalesce(i.accepted_at, u.last_sign_in_at, now())
  from auth.users u
 where lower(u.email) = lower(i.email)
   and i.company_id = '86aecd1e-d42c-43c0-976d-44189c1eb1b9'
   and i.status = 'pending'
   and u.last_sign_in_at is not null;


-- ---------------------------------------------------------------------
-- PART 3 - VERIFY
--
-- Expect: every row still showing 'pending' has an EMPTY last_sign_in_at.
-- Anyone who has signed in should now read 'accepted'.
-- ---------------------------------------------------------------------
select 'employee' as kind, i.email, i.status, i.accepted_at, u.last_sign_in_at
  from public.employee_invitations i
  left join auth.users u on lower(u.email) = lower(i.email)
 where i.company_id = '86aecd1e-d42c-43c0-976d-44189c1eb1b9'
union all
select 'customer' as kind, i.email, i.status, i.accepted_at, u.last_sign_in_at
  from public.customer_invitations i
  left join auth.users u on lower(u.email) = lower(i.email)
 where i.company_id = '86aecd1e-d42c-43c0-976d-44189c1eb1b9'
 order by 1, 2;


-- =====================================================================
-- UNDO - uncomment and run only if PART 1 causes a problem.
--
-- PART 2 is a data change and is NOT undone by this. The rows it marks
-- accepted are correct - there is no reason to revert them.
-- =====================================================================
/*
drop policy if exists employee_invitations_self_read on public.employee_invitations;
drop policy if exists customer_invitations_self_read on public.customer_invitations;
*/
